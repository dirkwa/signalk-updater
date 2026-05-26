import type { Plugin, ServerAPI } from '@signalk/server-api';
import type { IRouter, Request, Response } from 'express';
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

/**
 * Derive the Updater Console URL from the incoming HTTP request rather
 * than a hardcoded externalUrl. Reason: a browser hitting the admin UI
 * at http://192.168.0.122:3000 expects the "Open Updater Console" link
 * to go to http://192.168.0.122:3003, NOT to http://localhost:3003
 * (which is the BROWSER's localhost, not the SignalK box's).
 *
 * Honors X-Forwarded-Host when present (reverse-proxy setups). Strips
 * the port from the request's host before re-appending the engine
 * port — the admin UI and the engine container are on the same host
 * but different ports.
 *
 * If `config.externalUrl` was explicitly set to something other than
 * the default 'http://localhost:3003', the user is taking deliberate
 * control (custom reverse proxy, alternate hostname) — honor it.
 */
export function resolveGuiUrl(req: Request, configuredUrl: string): string {
  const isDefault = /^https?:\/\/localhost:3003\/?$/i.test(configuredUrl);
  if (!isDefault) return configuredUrl;

  const forwarded = req.headers['x-forwarded-host'];
  const forwardedFirst = Array.isArray(forwarded) ? forwarded[0] : forwarded;
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
async function fetchEngineVersion(externalUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${externalUrl.replace(/\/$/, '')}/api/health`, {
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
          currentVersion: () => fetchEngineVersion(state.config.externalUrl),
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
        const healthUrl = `${state.config.externalUrl.replace(/\/$/, '')}/api/health`;
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
        res.json({ url: resolveGuiUrl(req, state.config.externalUrl) });
      });
      router.get('/api/info', (_req: Request, res: Response) => {
        res.json({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: IMAGE,
          managedContainer: state.config.managedContainer,
          externalUrl: state.config.externalUrl,
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
        getTargetUrl: () => state.config.externalUrl,
        publicPathPrefix: `${PLUGIN_PATH_PREFIX}${CONSOLE_MOUNT}`,
      });
      router.use(CONSOLE_MOUNT, consoleProxy);
    },
  };

  return plugin;
}

// Signal K plugin loader expects a default export OR a `module.exports = (app) => plugin` style.
// We export the factory; the runtime calls it with the app instance.
