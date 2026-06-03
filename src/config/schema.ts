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
  logLevel: Type.Union([Type.Literal('error'), Type.Literal('info'), Type.Literal('debug')], {
    default: 'info',
    title: 'Log level',
  }),
});

export type Config = Static<typeof ConfigSchema>;

export const SCHEMA_DEFAULTS: Config = {
  managedContainer: false,
  logLevel: 'info',
};
