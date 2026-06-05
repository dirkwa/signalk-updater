import type { Plugin, ServerAPI } from '@signalk/server-api';
import type { IRouter, Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContainerManagerApi } from './types.js';
import { ConfigSchema, SCHEMA_DEFAULTS, type Config } from './config/schema.js';
import { createConsoleProxy } from './proxy.js';

const PLUGIN_PATH_PREFIX = '/plugins/signalk-updater';
const CONSOLE_MOUNT = '/console';

const PLUGIN_ID = 'signalk-updater';
const CONTAINER_NAME = 'signalk-updater-server';
const IMAGE = 'ghcr.io/dirkwa/signalk-updater-server';
const REPO = 'dirkwa/signalk-updater-server';
const ENGINE_PORT = 3003;
// Engine container Quadlet pins :latest by default (see signalk-universal-installer
// AGENTS.md "Engine images run on :latest"). The honest "what version is running"
// answer is the engine's own /api/health.version — see currentVersion() below.
const ENGINE_TAG = 'latest';

// signalk-server runs Network=host and the engine publishes its port on the
// host at 127.0.0.1:ENGINE_PORT, so loopback ALWAYS reaches the co-located
// engine from inside this container — no DNS, no mDNS. 127.0.0.1 (not
// localhost) dodges IPv6 ::1-first resolution; the engine is published on IPv4.
// This is what the server-side consumers (health probe, version fetch, console
// proxy) hit — never a user-supplied hostname, which the slim engine image
// can't resolve for .local/mDNS names.
export const ENGINE_LOCAL_URL = `http://127.0.0.1:${ENGINE_PORT}`;

/**
 * Derive the browser-facing Updater Console URL from the incoming HTTP request.
 * Reason: a browser hitting the admin UI at http://192.168.0.122:3000 expects
 * the "Open Updater Console" link to go to http://192.168.0.122:3003, NOT to
 * http://localhost:3003 (which is the BROWSER's localhost, not the SignalK box's).
 * A .local/mDNS host works here because the BROWSER resolves it (Bonjour/Avahi),
 * unlike the server-side probe which runs in a container that can't.
 *
 * Honors X-Forwarded-Host when present (reverse-proxy setups). Strips the port
 * from the request's host before re-appending the engine port — the admin UI
 * and the engine container are on the same host but different ports.
 */
export function resolveGuiUrl(req: Request): string {
  const forwarded = req.headers['x-forwarded-host'];
  // Behind chained proxies X-Forwarded-Host can be a comma-joined list; take
  // the first entry (same as the X-Forwarded-Proto handling below).
  const forwardedFirst = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(',')[0]
    ?.trim();
  const hostHeader = forwardedFirst || req.headers.host || `localhost:${ENGINE_PORT}`;
  // hostHeader is e.g. "192.168.0.122:3000" or "[::1]:3000" or "localhost:3000".
  // Strip the port; keep IPv6 brackets if present.
  let hostname = hostHeader;
  if (hostname.startsWith('[')) {
    const closeBracket = hostname.indexOf(']');
    if (closeBracket > 0) hostname = hostname.substring(0, closeBracket + 1);
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon > 0) hostname = hostname.substring(0, colon);
  }

  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
    (req.secure ? 'https' : 'http');
  return `${proto}://${hostname}:${ENGINE_PORT}`;
}

// Engine bearer resolution. The engine gates its mutating routes on its own
// bearer; we backfill it server-side on proxied requests (see proxy.ts
// getInjectToken). Two sources, tried in order:
//
//  1. Host token file (~/.signalk-updater/token, override:
//     SIGNALK_UPDATER_TOKEN_PATH). The engine writes it (mode 0600) and reads
//     it as /data/token. This is the proven source and works whenever the file
//     is readable from this process — but inside the signalk-server container
//     ~/.signalk-updater/token resolves to /home/node/.signalk-updater/token,
//     which is NOT mounted, so the read fails there.
//
//  2. Loopback GET /api/session on the engine. The engine serves its bearer
//     there, localhost-scoped by design; signalk-server runs Network=host so
//     loopback always reaches the co-located engine (same transport
//     fetchEngineVersion() uses for /api/health). This needs no host mount and
//     is container-filesystem-independent — it's what fixes the in-container
//     case where source (1) can't see the file.
//
// The token is install-stable, so the first success is cached for the process
// lifetime. getInjectToken in proxy.ts is synchronous and on the hot request
// path; we keep it sync by serving this cache and refreshing in the background.
const ENGINE_TOKEN_PATH =
  process.env.SIGNALK_UPDATER_TOKEN_PATH ?? join(homedir(), '.signalk-updater', 'token');

let cachedEngineToken: string | null = null;
// Coalesces concurrent /api/session fetches so a burst of cache-missing
// requests triggers exactly one loopback round-trip.
let tokenRefreshInFlight: Promise<void> | null = null;

/** Read a token from a file. Null on missing/unreadable/empty. */
function readTokenFromFile(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Extract the bearer from the engine's /api/session JSON ({ token: string }).
 * Defensive against shape drift — returns null on anything that isn't a
 * non-empty string token, so a malformed response fails open (proxy forwards
 * unchanged) rather than injecting garbage.
 */
function extractSessionToken(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const token = (raw as Record<string, unknown>).token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Fetch the engine bearer over loopback from /api/session. 3s timeout (same as
 * fetchEngineVersion) so a hung engine can't wedge the refresh. Returns null on
 * any failure; callers must NOT cache the null, so a token that appears after a
 * slow engine boot is still picked up on a later refresh.
 */
async function fetchEngineTokenFromSession(baseUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/session`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const raw: unknown = await res.json();
      return extractSessionToken(raw);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Resolve the engine bearer once and memoise it. Tries the host token file
 * first (proven, no network), then /api/session over loopback (fixes the
 * in-container case where the file isn't mounted). Only stores a non-null
 * result, so a transient failure (engine still booting) is retried on the next
 * call. Concurrent callers share one in-flight resolve.
 */
async function refreshEngineToken(baseUrl: string): Promise<void> {
  if (cachedEngineToken !== null) return;
  if (tokenRefreshInFlight) return tokenRefreshInFlight;
  tokenRefreshInFlight = (async () => {
    try {
      const fromFile = readTokenFromFile(ENGINE_TOKEN_PATH);
      const token = fromFile ?? (await fetchEngineTokenFromSession(baseUrl));
      if (token) cachedEngineToken = token;
    } finally {
      tokenRefreshInFlight = null;
    }
  })();
  return tokenRefreshInFlight;
}

/**
 * Synchronous token getter for the proxy's hot path (proxy.ts getInjectToken).
 * Returns the cached engine bearer, or null when it isn't primed yet. On a
 * miss it kicks a non-blocking background refresh and fails open for THIS
 * request (forward unchanged) — the token lands before the next mutating call.
 * Never awaits, never throws.
 *
 * Fast path for the common (non-container) install: when the host token file
 * is readable, read it synchronously so the very first request already injects
 * — no first-request miss, identical to the old behavior. Only when the file
 * is absent (the in-container case) do we fall back to the async-primed cache.
 */
function getEngineTokenSync(baseUrl: string): string | null {
  if (cachedEngineToken !== null) return cachedEngineToken;
  const fromFile = readTokenFromFile(ENGINE_TOKEN_PATH);
  if (fromFile) {
    cachedEngineToken = fromFile;
    return fromFile;
  }
  // File absent (in-container): kick a non-blocking /api/session refresh and
  // fail open for this request. Swallow rejection defensively.
  void refreshEngineToken(baseUrl).catch(() => undefined);
  return null;
}

/** Test hook: reset the memoised engine token between cases. */
export function __resetEngineTokenCacheForTest(): void {
  cachedEngineToken = null;
  tokenRefreshInFlight = null;
}

function getContainerManager(): ContainerManagerApi | undefined {
  return globalThis.__signalk_containerManager;
}

/**
 * Wait until signalk-container is loaded AND its runtime probe has settled.
 * Same pattern as signalk-backup — we load alphabetically before signalk-container,
 * so polling lets us race that gap without flapping.
 */
async function waitForContainerManager(
  maxMs: number,
  intervalMs = 500,
): Promise<ContainerManagerApi | undefined> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const m = getContainerManager();
    if (m && m.getRuntime()) return m;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return getContainerManager();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask the engine container for its running semver via /api/health. Used as
 * the `currentVersion` callback on signalk-container's update registration —
 * the comparator prefers this over `currentTag` when present, so the
 * "available vs running" diff is computed against the engine's honest
 * RuntimeIdentity rather than a stale Quadlet tag string or a hand-bumped
 * plugin-side constant.
 *
 * 3s timeout — signalk-container's update check is async and a hung engine
 * shouldn't block its tick. Null on any failure; the comparator falls back
 * to currentTag (which is "latest" — a floating tag the comparator treats
 * as undefined-version, no upgrade offered).
 */
async function fetchEngineVersion(baseUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const raw: unknown = await res.json();
      const version =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>).version
          : undefined;
      return typeof version === 'string' && version.length > 0 ? version : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

interface PluginInternalState {
  config: Config;
  app: ServerAPI;
  containers?: ContainerManagerApi;
}

export default function pluginFactory(app: ServerAPI): Plugin {
  const state: PluginInternalState = {
    config: { ...SCHEMA_DEFAULTS },
    app,
  };

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Updater',
    description:
      'Thin-shell plugin that registers the signalk-updater-server container for update tracking ' +
      'and opens the Updater Console from the admin UI.',

    schema(): unknown {
      return ConfigSchema;
    },

    async start(rawConfig: unknown): Promise<void> {
      // Signal K does not seed schema defaults at runtime — spread over the raw config so
      // missing keys land at their declared defaults. (signalk-backup AGENTS.md, "Gotchas".)
      const config = { ...SCHEMA_DEFAULTS, ...(rawConfig as Partial<Config>) };
      state.config = config;

      const containers = await waitForContainerManager(30_000);
      if (!containers) {
        app.setPluginError(
          'signalk-container is not loaded — install it and restart the server. ' +
            'The plugin will not register updates without it.',
        );
        return;
      }
      state.containers = containers;

      // Adopt-only: the bash installer starts the container as a Quadlet, this plugin only
      // registers it for update notifications. managedContainer=true is an opt-in fallback.
      try {
        containers.updates.register({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: IMAGE,
          // OperatorIntent: the Quadlet pins :latest, so that's the tag the
          // operator tracks. signalk-container's comparator falls through to
          // currentVersion() for the actual semver compare.
          currentTag: () => ENGINE_TAG,
          // RuntimeIdentity: ask the engine itself. /api/health.version is
          // the canonical "what version am I" answer — read from the engine's
          // package.json at boot. Eliminates the previous hand-bumped
          // UPDATER_SERVER_VERSION constant, which silently went stale on
          // every engine release and forced an extra plugin PR per bump.
          currentVersion: () => fetchEngineVersion(ENGINE_LOCAL_URL),
          versionSource: containers.updates.sources.githubReleases(REPO),
          checkInterval: '24h',
        });
      } catch (err) {
        app.setPluginError(`update registration failed: ${errMsg(err)}`);
      }

      // Sanity check the peer container is actually reachable. We HTTP-probe its own
      // /api/health rather than calling containers.getState() — signalk-container's API
      // prefixes container names with `sk-` (the plugin-engine convention), and our
      // peer containers don't carry that prefix (they're systemd-managed peers, not
      // plugin-managed children). A direct health probe also catches the case where
      // the container is technically "running" but stuck/unhealthy. Never throw —
      // the plugin must never take signalk-server down.
      try {
        const healthUrl = `${ENGINE_LOCAL_URL}/api/health`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        let reachable = false;
        try {
          const res = await fetch(healthUrl, { signal: controller.signal });
          reachable = res.ok;
        } catch {
          reachable = false;
        } finally {
          clearTimeout(timer);
        }
        if (!reachable) {
          app.setPluginError(
            `${CONTAINER_NAME} is not reachable at ${healthUrl}. ` +
              `Run the bash installer or \`systemctl --user start ${CONTAINER_NAME}.service\`.`,
          );
        }
      } catch (err) {
        app.setPluginError(`could not probe ${CONTAINER_NAME}: ${errMsg(err)}`);
      }

      // Prime the engine bearer cache so the first mutating console request
      // (settings/switch/lifecycle) already has a token to inject — avoids a
      // first-request fail-open 401 in the in-container case where the token
      // comes from /api/session over loopback (the host file isn't mounted).
      // Best-effort: a failure here just means getEngineTokenSync primes it
      // lazily on the first request instead. Not awaited — never block start().
      void refreshEngineToken(ENGINE_LOCAL_URL).catch(() => undefined);
    },

    stop(): void {
      try {
        state.containers?.updates.unregister(PLUGIN_ID);
      } catch {
        // best-effort
      }
    },

    registerWithRouter(router: IRouter): void {
      router.get('/api/gui-url', (req: Request, res: Response) => {
        res.json({ url: resolveGuiUrl(req) });
      });
      router.get('/api/info', (_req: Request, res: Response) => {
        res.json({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: IMAGE,
          managedContainer: state.config.managedContainer,
          engineUrl: ENGINE_LOCAL_URL,
          // OperatorIntent — the channel the Quadlet tracks. The engine's
          // real running version is at /api/health on the engine itself
          // (not proxied here — callers go direct).
          currentTag: ENGINE_TAG,
        });
      });

      // Same-origin reverse proxy to the engine console. Lets the embedded
      // React AppPanel iframe the engine UI without mixed-content or CORS
      // issues, and works behind HTTPS reverse proxies (Traefik/nginx) in
      // front of signalk-server. See src/proxy.ts for SSE/HTML-injection
      // details. Requires the engine UI to read <meta name="api-base"> for
      // all API calls — see signalk-updater-server release notes.
      const consoleProxy = createConsoleProxy({
        getTargetUrl: () => ENGINE_LOCAL_URL,
        publicPathPrefix: `${PLUGIN_PATH_PREFIX}${CONSOLE_MOUNT}`,
        // Backfill the engine bearer so mutating console calls (settings,
        // switch, lifecycle) work in the embedded iframe, where the browser
        // can't carry the engine's own token through signalk-server's auth
        // gate. Requests only reach here after that gate, so the client is
        // already authorized.
        getInjectToken: () => getEngineTokenSync(ENGINE_LOCAL_URL),
      });
      router.use(CONSOLE_MOUNT, consoleProxy);
    },
  };

  return plugin;
}

// Signal K plugin loader expects a default export OR a `module.exports = (app) => plugin` style.
// We export the factory; the runtime calls it with the app instance.
