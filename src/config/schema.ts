import { Type, type Static } from '@sinclair/typebox';

export const ConfigSchema = Type.Object({
  managedContainer: Type.Boolean({
    default: false,
    title: 'Manage the updater container from this plugin',
    description:
      'If true, the plugin will attempt to ensureRunning the updater container. ' +
      'Default false — the bash installer starts the container as a systemd Quadlet, ' +
      'and that path is what survives plugin failures. Set to true only if you understand ' +
      "what you're doing.",
  }),
  imageTag: Type.String({
    default: 'auto',
    title: 'Updater image tag',
    description:
      'Container image tag to track for update notifications. "auto" resolves to the ' +
      'UPDATER_SERVER_VERSION constant baked into the plugin at build time. Pin to a ' +
      'specific tag (e.g. "0.6.0") to override.',
  }),
  externalUrl: Type.String({
    default: 'http://localhost:3003',
    title: 'Updater console URL',
    description:
      'Where the Updater Console is reachable. Defaults to the localhost-bound port the ' +
      'installer set up. Change only if you front the updater with a custom reverse proxy.',
  }),
  logLevel: Type.Union([Type.Literal('error'), Type.Literal('info'), Type.Literal('debug')], {
    default: 'info',
    title: 'Log level',
  }),
});

export type Config = Static<typeof ConfigSchema>;

export const SCHEMA_DEFAULTS: Config = {
  managedContainer: false,
  imageTag: 'auto',
  externalUrl: 'http://localhost:3003',
  logLevel: 'info',
};
