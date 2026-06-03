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

| Field              | Default  | Purpose                                                                                                                                                               |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managedContainer` | `false`  | Advanced opt-in. If `true`, the plugin will (eventually) attempt to start the container itself. Default off — the bash installer's Quadlet is the authoritative path. |
| `imageTag`         | `latest` | Image tag to track for update notifications.                                                                                                                          |
| `logLevel`         | `info`   | `error` \| `info` \| `debug`.                                                                                                                                         |

## Companion repos

| Repo                                                                                 | Role                                                |
| ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) | Bash bootstrap that drops the systemd Quadlets.     |
| [signalk-updater-server](https://github.com/dirkwa/signalk-updater-server)           | Engine container — the real updater service.        |
| [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server)             | Sister engine container for diagnostics + recovery. |
| [signalk-container](https://github.com/dirkwa/signalk-container)                     | Cross-plugin container-runtime substrate.           |
