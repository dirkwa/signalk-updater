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
  publishNotifications: Type.Boolean({
    default: true,
    title: 'Publish updater notifications',
    description:
      'Poll the updater engine and republish its warn/fail conditions ' +
      '(update available on your channel, stale operation lock, a failed ' +
      'self-update, a stopped/unhealthy container) as SignalK notifications ' +
      'under notifications.updater.<id>, so alarm panels (KIP, etc.) surface ' +
      'them. Cleared (state: normal) when a condition resolves. Disable to ' +
      'keep updater status confined to the Updater Console.',
  }),
  notificationIntervalSeconds: Type.Number({
    default: 60,
    minimum: 10,
    title: 'Notification poll interval (seconds)',
    description:
      'How often to poll the updater engine for status. Minimum 10s. ' +
      'Only used when "Publish updater notifications" is on.',
  }),
});

export type Config = Static<typeof ConfigSchema>;

export const SCHEMA_DEFAULTS: Config = {
  managedContainer: false,
  logLevel: 'info',
  publishNotifications: true,
  notificationIntervalSeconds: 60,
};
