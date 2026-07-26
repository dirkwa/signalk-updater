# signalk-updater

Thin-shell SignalK plugin that opens the SignalK Updater Console from the admin UI and registers the updater engine container for image-update tracking.

The heavy lifting (image listing, version switching, self-update, hardware UI) happens in the [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server) container, which the [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) drops as a systemd Quadlet. This plugin is just the deep-link from the admin UI.

> Status: **0.1.0**. First release; pairs with signalk-updater-server 0.x.

## What this plugin does

- Polls for `globalThis.__signalk_containerManager` (provided by `signalk-container`).
- Calls `containers.updates.register({...})` to enroll the updater container for update notifications — without `ensureRunning`. The container's lifecycle is owned by systemd, not this plugin (marine-reliability principle: a broken plugin must never break recovery).
- Verifies the updater container is `running`; on any other state, raises a plugin error in the admin UI explaining how to recover (without taking the server down).
- Serves a webapp at `/signalk-updater/` that embeds the Updater Console same-origin under `/plugins/signalk-updater/console/`. The console proxy forwards to the co-located engine over loopback (`http://127.0.0.1:3003`); signalk-server runs `Network=host` so loopback always reaches it with no DNS.

## What this plugin does **not** do

- Start, stop, or recreate the updater container. The bash installer sets up the systemd Quadlet; this plugin only adopts it for update tracking.
- Mutate any host state. The `managedContainer: true` advanced toggle hints at a fallback `ensureRunning` path, but the default is `false` and that's what should ship in production.

## Configuration

The plugin config schema (`src/config/schema.ts`) is the source of truth for defaults and constraints; this table is a summary.

| Field                         | Default | Purpose                                                                                                                                                   |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managedContainer`            | `false` | Advanced opt-in. If `true`, the plugin attempts to start the container itself instead of relying on the installer's Quadlet. Leave `false` in production. |
| `logLevel`                    | `info`  | `error` \| `info` \| `debug`.                                                                                                                             |
| `publishNotifications`        | `true`  | Republish the updater engine's `warn`/`fail` conditions as SignalK notifications. Turn off to keep updater status confined to the Updater Console.        |
| `notificationIntervalSeconds` | `60`    | How often to poll the engine for status (minimum 10s). Only used when `publishNotifications` is on.                                                       |

## Updater notifications

When `publishNotifications` is on (the default), the plugin polls the engine's `GET /api/updater-status` and mirrors each **warn**/**fail** condition into the SignalK data model under `notifications.updater.<id>`, so alarm panels (KIP, etc.) surface them:

| Condition (engine status)                                      | Notification `state` | `method`           |
| -------------------------------------------------------------- | -------------------- | ------------------ |
| update available on your channel / stale operation lock (warn) | `warn`               | `visual`           |
| container stopped/unhealthy / failed self-update (fail)        | `alarm`              | `visual` + `sound` |
| resolved (ok)                                                  | cleared → `normal`   | —                  |
| couldn't-measure (unknown)                                     | not raised           | —                  |

**Channel-aware update-available:** the engine decides "is a newer image available" against the channel you're running — a `dirkwa` user is warned on a newer `dirkwa` image (via image-digest drift), a `beta` user on a newer beta **or** stable, a stable user only on a newer stable, a `master` user on a moved master digest. This coexists with (and is more specific than) signalk-container's one-shot `notifications.plugins.signalk-updater.updateAvailable`.

When a condition recovers, its notification is set to `state: normal`; the plugin also clears every active notification on `stop()`, so a shutdown never leaves a stale updater alarm latched. A transient engine-unreachable poll is skipped without clearing existing notifications. The plugin reaches the engine over loopback (`http://127.0.0.1:3003` by default; override the port with `SIGNALK_UPDATER_ENGINE_PORT`). `GET /api/updater-status` is read-only (token-or-localhost), so the loopback poll needs no token.

## Companion repos

| Repo                                                                                 | Role                                                |
| ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) | Bash bootstrap that drops the systemd Quadlets.     |
| [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server)           | Engine container — the real updater service.        |
| [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server)             | Sister engine container for diagnostics + recovery. |
| [signalk-container](https://github.com/dirkwa/signalk-container)                     | Cross-plugin container-runtime substrate.           |
