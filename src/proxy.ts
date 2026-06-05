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
  /**
   * Returns the engine's bearer token, or null when it can't be read.
   *
   * Every request reaching this proxy has already cleared signalk-server's
   * own auth gate (the proxy is mounted on the plugin router, which is behind
   * that gate), so the client is authorized. But the engine's mutating routes
   * gate on their OWN bearer (`/data/token`), which the browser can't supply
   * in the embedded iframe: the engine's `/api/session` is reached through
   * this same proxy, and when signalk-server security is enabled an
   * unauthenticated tab never gets past the outer gate to load it. The result
   * is a silent 401 on every settings/switch/lifecycle write — see the engine
   * repo's "Show beta does nothing" investigation.
   *
   * We close that gap server-side: read the engine token (the host file the
   * engine itself reads as `/data/token`) and inject it as the upstream
   * Authorization when the client didn't already send a bearer. Optional and
   * fail-open — null means "forward unchanged", so reads keep working and the
   * only regression is the pre-existing 401 on writes.
   */
  getInjectToken?: () => string | null;
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

    // Backfill the engine bearer when the client didn't already send one.
    // Only when absent, so a real caller-supplied token (standalone/direct
    // use) wins and we never clobber it. The engine accepts the token via
    // EITHER Authorization: Bearer OR X-SK-Auth (see the engine's
    // extractToken), so a client authenticating with either header must be
    // left untouched — we set both only when both are absent. Fail-open: a
    // null token forwards unchanged.
    const hasBearer = /^Bearer\s+\S/i.test(String(headers['authorization'] ?? ''));
    const hasSkAuth = String(headers['x-sk-auth'] ?? '').trim().length > 0;
    if (!hasBearer && !hasSkAuth) {
      const token = opts.getInjectToken?.() ?? null;
      if (token) {
        headers['authorization'] = `Bearer ${token}`;
        headers['x-sk-auth'] = token;
      }
    }

    // Request-body forwarding. signalk-server mounts a global body-parser
    // (express.json/urlencoded) that runs BEFORE this plugin router, so by the
    // time we run, a body-carrying request's stream is already fully consumed:
    // req.readableEnded === true and the req.pipe(proxyReq) below would forward
    // ZERO bytes — while the client's Content-Length header (copied verbatim
    // above) still announces N bytes. The engine (fastify) then blocks forever
    // waiting for a body that never arrives => the proxy header-watchdog or the
    // client times out => 502/000. GET/no-body requests have no Content-Length
    // to wait on and the stream is never drained, so they were unaffected.
    //
    // Fix: when the stream is already drained, re-serialize the parsed body
    // (req.body) by content-type and send it ourselves with a recomputed
    // Content-Length. When the stream is still live (GET/no-body, SSE, an
    // upgrade, or any path the global parser didn't consume), leave everything
    // untouched and pipe as before.
    const streamDrained = req.readableEnded;
    const serializedBody = streamDrained
      ? encodeParsedBody(req.headers['content-type'], req.body)
      : null;
    if (serializedBody) {
      // We own the body now: pin Content-Type to what we actually serialized
      // and Content-Length to its exact byte count. Delete first so a
      // differently-cased incoming header can't survive alongside ours.
      delete headers['content-length'];
      delete headers['content-type'];
      headers['content-type'] = serializedBody.contentType;
      headers['content-length'] = String(serializedBody.buffer.byteLength);
    } else if (streamDrained) {
      // Stream drained but nothing to re-serialize: an empty parsed body
      // (e.g. JSON `{}` — the engine's `POST /api/updates/check` payload), a
      // content-type we don't re-encode, or a body the parser reduced away.
      // Make the upstream request FULLY bodyless: drop BOTH Content-Length and
      // Content-Type. Dropping only Content-Length is not enough — fastify
      // rejects `Content-Type: application/json` with an empty body as
      // 400 FST_ERR_CTP_EMPTY_JSON_BODY. With neither header, the engine treats
      // it as a clean bodyless request and the empty pipe below adds no bytes.
      delete headers['content-length'];
      delete headers['content-type'];
    }

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

    // Forward the request body. Two cases (see the header block above):
    //  - serializedBody !== null: the global body-parser already drained the
    //    stream; write the re-serialized bytes ourselves (Content-Length/Type
    //    were fixed up above) and end the upstream request.
    //  - otherwise: the stream is still live (GET/no-body, SSE, upgrade, or an
    //    unparsed path) OR it was drained with nothing to re-send. Pipe it
    //    through unbuffered exactly as before — SSE and streaming paths are
    //    untouched; a drained-empty stream simply contributes no bytes and
    //    ends, and we already stripped Content-Length/Type so the engine
    //    treats it as bodyless.
    if (serializedBody) {
      proxyReq.end(serializedBody.buffer);
    } else {
      req.pipe(proxyReq);
    }
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
 * Re-serialize a request body that signalk-server's global body-parser already
 * consumed off the wire, so we can forward it to the engine with a correct
 * Content-Length. Returns null when there is nothing meaningful to send (no
 * parsed body, an empty parsed object, or a content-type we don't re-encode),
 * in which case the caller forwards the request as fully bodyless.
 *
 * Only JSON and urlencoded are reconstructed — those are the two parsers
 * signalk-server enables, and they're the only shapes whose original bytes are
 * gone by the time this plugin runs. A body the global parser did NOT consume
 * never reaches here: req.readableEnded is false for it, so the caller pipes.
 *
 * req.body is typed `any` by @types/express; we accept it as `unknown` here
 * (an allowed widening that trips no no-explicit-any rule) and narrow with the
 * user-defined type guards below.
 */
function encodeParsedBody(
  contentType: string | string[] | undefined,
  body: unknown,
): { buffer: Buffer; contentType: string } | null {
  const rawType = Array.isArray(contentType) ? contentType[0] : contentType;
  const headerValue = rawType ?? '';
  const type = headerValue.toLowerCase();

  if (type.includes('application/json')) {
    // express.json() sets body to {} for an empty/zero-length JSON request and
    // can also yield a top-level array. An object with no keys has no bytes
    // worth forwarding (and the engine 400s an empty-but-typed JSON body), so
    // skip it; a non-empty object or any array is re-serialized faithfully.
    // The engine's mutating routes take JSON objects today; arrays are covered
    // for completeness so a future array payload round-trips rather than being
    // silently dropped to bodyless.
    if (!isNonEmptyObject(body) && !Array.isArray(body)) return null;
    return {
      buffer: Buffer.from(JSON.stringify(body), 'utf8'),
      // Preserve the original charset/parameters when present.
      contentType: headerValue || 'application/json',
    };
  }

  if (type.includes('application/x-www-form-urlencoded')) {
    // express.urlencoded({ extended: true }) (signalk-server's setting) can
    // produce nested objects/arrays for keys like a[b]=1. We only faithfully
    // rebuild a FLAT string map; anything richer can't be round-tripped here,
    // so it falls through to null (bodyless). No engine route uses urlencoded,
    // so this is a correctness floor, not a live path.
    if (!isStringRecord(body)) return null;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) params.append(k, v);
    const encoded = params.toString();
    if (encoded.length === 0) return null;
    return {
      buffer: Buffer.from(encoded, 'utf8'),
      contentType: headerValue || 'application/x-www-form-urlencoded',
    };
  }

  // Any other content-type: either the parser didn't run (stream still live,
  // handled by the pipe branch) or it's a shape we can't faithfully rebuild.
  return null;
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === 'string');
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
