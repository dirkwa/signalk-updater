import type { Plugin, ServerAPI } from '@signalk/server-api';
import type { IRouter, Request, Response } from 'express';
import type { ContainerManagerApi } from './types.js';
import { ConfigSchema, SCHEMA_DEFAULTS, type Config } from './config/schema.js';

const PLUGIN_ID = 'signalk-updater';
const CONTAINER_NAME = 'signalk-updater-server';
const IMAGE = 'ghcr.io/dirkwa/signalk-updater-server';
const REPO = 'dirkwa/signalk-updater-server';

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
          currentTag: () => state.config.imageTag,
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
      router.get('/api/gui-url', (_req: Request, res: Response) => {
        res.json({ url: state.config.externalUrl });
      });
      router.get('/api/info', (_req: Request, res: Response) => {
        res.json({
          pluginId: PLUGIN_ID,
          containerName: CONTAINER_NAME,
          image: IMAGE,
          managedContainer: state.config.managedContainer,
          externalUrl: state.config.externalUrl,
        });
      });
    },
  };

  return plugin;
}

// Signal K plugin loader expects a default export OR a `module.exports = (app) => plugin` style.
// We export the factory; the runtime calls it with the app instance.
