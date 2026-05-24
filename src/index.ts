import type { Plugin, ServerAPI } from '@signalk/server-api';
import type { IRouter, Request, Response } from 'express';
import type { ContainerManagerApi } from './types.js';
import { ConfigSchema, SCHEMA_DEFAULTS, type Config } from './config/schema.js';
import { resolveImageTag, UPDATER_SERVER_VERSION } from './config/image-tag.js';

const PLUGIN_ID = 'signalk-updater';
const CONTAINER_NAME = 'signalk-updater-server';
const IMAGE = 'ghcr.io/dirkwa/signalk-updater-server';
const REPO = 'dirkwa/signalk-updater-server';
const ENGINE_PORT = 3003;

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
          // Resolve "auto" against the hand-bumped UPDATER_SERVER_VERSION
          // constant so signalk-container's update comparator gets a real
          // semver tag to compare against, not the literal "auto".
          currentTag: () => resolveImageTag(state.config.imageTag),
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
        const configuredTag = state.config.imageTag;
        res.json({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: IMAGE,
          managedContainer: state.config.managedContainer,
          externalUrl: state.config.externalUrl,
          // Expose both what the user configured ("auto" or a pinned tag)
          // and what it resolves to, so the Updater Console can show the
          // expected-vs-actual gap if any.
          configuredTag,
          resolvedTag: resolveImageTag(configuredTag),
          updaterServerVersion: UPDATER_SERVER_VERSION,
        });
      });
    },
  };

  return plugin;
}

// Signal K plugin loader expects a default export OR a `module.exports = (app) => plugin` style.
// We export the factory; the runtime calls it with the app instance.
