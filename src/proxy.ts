/**
 * Same-origin reverse proxy from /plugins/signalk-updater/console/* to the
 * signalk-updater-server engine container over loopback (http://127.0.0.1:3003).
 *
 * Why same-origin: lets the embedded React panel in the SignalK admin UI
 * iframe the engine console without mixed-content (HTTPS-to-HTTP) or CORS
 * pain, and works behind Traefik/nginx HTTPS reverse proxies in front of
 * the SignalK server.
 *
 * SSE-aware: the engine uses EventSource for live update streams. We do
 * not buffer responses (req.pipe / proxyRes.pipe), and we forward all
 * headers including Content-Type: text/event-stream verbatim.
 *
 * HTML rewriting: only for text/html responses, we inject a
 * <meta name="api-base"> tag into <head> that tells the engine UI where
 * its API lives. The engine's api.ts and EventSource sites read this
 * meta tag at boot. Without it the engine UI defaults to root paths
 * (which is what it does when loaded standalone at :3003).
 *
 * The engine UI must also be built with Vite `base: './'` so its HTML
 * emits relative asset URLs — without that, <script src="/assets/x.js">
 * resolves against the host root, not the proxy prefix, and bypasses
 * this plugin entirely.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { Request, Response } from 'express';

/**
 * Max time we wait for the upstream to begin responding (headers received).
 * Once headers arrive we clear the timeout — long-lived SSE streams may
 * legitimately go minutes without bytes, so a total-request timeout would
 * kill them. The header-arrival window protects against an unresponsive
 * engine without breaking live streams.
 */
const UPSTREAM_HEADER_TIMEOUT_MS = 15_000;

/** Hop-by-hop headers per RFC 7230 §6.1 — must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

interface ProxyOptions {
  /** Returns the engine base URL — the co-located engine over loopback, e.g. "http://127.0.0.1:3003". */
  getTargetUrl: () => string;
  /** Public-facing path prefix where this proxy is mounted, used for the api-base meta tag (e.g. "/plugins/signalk-updater/console"). */
  publicPathPrefix: string;
}

export function createConsoleProxy(opts: ProxyOptions) {
  return (req: Request, res: Response): void => {
    let target: URL;
    try {
      target = new URL(opts.getTargetUrl());
    } catch (err) {
      res
        .status(500)
        .type('text/plain')
        .send(`Invalid engine URL: ${errMsg(err)}`);
      return;
    }

    // req.url has already had the mount prefix stripped by Express. For
    // "/plugins/signalk-updater/console/foo" mounted at "/console", req.url
    // is "/foo". joinUpstreamPath preserves any non-root base on the target
    // URL so /api/health → /<base>/api/health upstream.
    const path = joinUpstreamPath(target.pathname, req.url);

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers['host'] = target.host;
    // Strip Accept-Encoding so the engine sends uncompressed bodies. This
    // keeps HTML rewriting simple (no gunzip step) and is fine on localhost.
    delete headers['accept-encoding'];

    // Watchdog: arm before sending the request; the 'response' callback
    // (or any of the error paths below) clears it. If headers don't arrive
    // within the window we destroy the upstream socket and fail the client
    // with 504; the existing 'error' handler turns that into a clean
    // response.
    let headerTimer: ReturnType<typeof setTimeout>;

    const transport = target.protocol === 'https:' ? https : http;
    const proxyReq = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path,
        headers,
      },
      (proxyRes) => {
        // Headers arrived; cancel the upstream-stall watchdog so SSE/long
        // polls don't get killed mid-stream.
        clearTimeout(headerTimer);
        const status = proxyRes.statusCode ?? 502;
        const contentType = (proxyRes.headers['content-type'] ?? '').toString().toLowerCase();
        const isHtml = contentType.includes('text/html');

        if (isHtml) {
          // Buffer HTML so we can inject the api-base meta tag in one shot.
          const chunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          proxyRes.on('end', () => {
            const original = Buffer.concat(chunks).toString('utf8');
            const rewritten = injectApiBaseMeta(original, opts.publicPathPrefix);
            const headersOut = filterAndCopyHeaders(proxyRes.headers);
            // Length changed; let Express recompute it.
            delete headersOut['content-length'];
            res.status(status);
            for (const [k, v] of Object.entries(headersOut)) {
              if (v !== undefined) res.setHeader(k, v);
            }
            res.send(rewritten);
          });
          proxyRes.on('error', (err) => {
            if (!res.headersSent) {
              res
                .status(502)
                .type('text/plain')
                .send(`Upstream error: ${errMsg(err)}`);
            } else {
              res.end();
            }
          });
          return;
        }

        // Non-HTML: stream through unmodified. Critical for SSE — any
        // buffering here breaks live update streams.
        res.status(status);
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) {
            res.setHeader(k, v);
          }
        }
        // SSE buffering defense. signalk-server's compression middleware
        // wraps every response and DOES compress text/event-stream by
        // default (compressible('text/event-stream') === true). Gzip
        // buffers ~16 kB before flushing, so the browser sees no events
        // for minutes despite our pipe writing immediately. The
        // documented opt-out is Cache-Control: no-transform — see
        // compression's shouldTransform() guard. The engine's SSE
        // responses ship with Cache-Control: no-cache; we append
        // no-transform iff it isn't already there, then flush headers
        // so the EventSource sees an open stream right away.
        if (contentType.includes('text/event-stream')) {
          const existingCacheControl = (res.getHeader('Cache-Control') ?? '').toString();
          if (!/(^|,)\s*no-transform\s*(,|$)/i.test(existingCacheControl)) {
            const merged = existingCacheControl
              ? `${existingCacheControl}, no-transform`
              : 'no-cache, no-transform';
            res.setHeader('Cache-Control', merged);
          }
          res.flushHeaders();
        }
        proxyRes.pipe(res);
      },
    );

    headerTimer = setTimeout(() => {
      proxyReq.destroy(new Error('upstream header timeout'));
    }, UPSTREAM_HEADER_TIMEOUT_MS);

    proxyReq.on('error', (err) => {
      clearTimeout(headerTimer);
      if (!res.headersSent) {
        res
          .status(502)
          .type('text/plain')
          .send(
            `Updater console at ${target.origin} is not reachable: ${errMsg(err)}\n` +
              `Check: systemctl --user status signalk-updater-server.service`,
          );
      } else {
        res.end();
      }
    });

    // Forward the client request body (POST/PUT/etc) without buffering.
    req.pipe(proxyReq);
  };
}

function filterAndCopyHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Concatenate the upstream's base pathname with the client's request path.
 * Yields a single leading slash, exactly one slash between segments, and
 * preserves the client's query/fragment (Express passes them as part of
 * req.url). Empty client path is treated as "/" so an upstream like
 * https://host/updater/ serves its index at /updater/.
 */
export function joinUpstreamPath(basePath: string, clientPath: string): string {
  const base = (basePath || '/').replace(/\/+$/, '');
  const tail = clientPath === '' ? '/' : clientPath;
  const normalizedTail = tail.startsWith('/') ? tail : `/${tail}`;
  const joined = `${base}${normalizedTail}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/**
 * Insert <meta name="api-base" content="<prefix>"> immediately after <head>.
 * The engine UI's api.ts and EventSource sites read this at boot to prefix
 * all API paths. Idempotent — replaces an existing tag if present.
 */
export function injectApiBaseMeta(html: string, prefix: string): string {
  const tag = `<meta name="api-base" content="${escapeAttr(prefix)}">`;
  const existing = /<meta\s+name=["']api-base["'][^>]*>/i;
  if (existing.test(html)) {
    return html.replace(existing, tag);
  }
  const headOpen = /<head(\s[^>]*)?>/i;
  if (headOpen.test(html)) {
    return html.replace(headOpen, (match) => `${match}\n    ${tag}`);
  }
  // No <head> at all — engine isn't serving an HTML document we recognize,
  // pass through unchanged rather than mangle.
  return html;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
