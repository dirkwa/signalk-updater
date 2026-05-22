# signalk-updater

Thin-shell SignalK plugin that deep-links into the `signalk-updater-server` engine container. Mirrors the `signalk-backup` pattern.

## Architecture rules you must keep in mind

- **Adopt, don't manage.** Default `managedContainer: false`. The bash installer drops the systemd Quadlet for `signalk-updater-server`; this plugin only calls `updates.register()` to enroll for update notifications. Never `ensureRunning()` in the default path.
- **Never crash signalk-server.** On any failure (signalk-container missing, container not running, registration error), call `app.setPluginError(...)` — never throw out of `start()`.
- **Loose coupling.** Hand-rolled `src/types.ts` mirrors signalk-container's API surface. Never `import` signalk-container directly.
- **Spread schema defaults at start.** Signal K does not seed schema defaults at runtime; spread `SCHEMA_DEFAULTS` over the incoming config in `start()`. (See signalk-backup AGENTS.md "Gotchas".)
- **Webapp is a redirect shell.** No React. Vanilla TS that fetches `/api/gui-url`, then `window.location.replace`s. If the updater container is unreachable, render a clear "use signalk-recovery" fallback (CC-3).

## Workflow Conventions

This repo is maintained by Dirk Wahrheit.

- Branch names use **hyphens**, never slashes.
- Angular conventional commits: `<type>(<scope>): <subject>`. Subject ≤ 50 chars, imperative, no period.
- One logical change per commit.
- No `Co-Authored-By` lines. No "Generated with Claude Code" attribution.
- Never commit directly to `main`. Every change goes through a PR.
- Version bumps live in their own `chore(release): X.Y.Z` PR.
- PR descriptions: no checkboxes. "Tested" lists what actually ran, not what was planned.

### Pre-PR checklist

```bash
npm run format
npm run build:all        # lint + tsc + vite + vitest
npm run ci-lint
cr review --plain | tee /tmp/cr-review-<branch>.txt
```

Skip `cr review` only for `chore(release): X.Y.Z` PRs.

## File layout

| Path                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `src/index.ts`         | Plugin entry. Adopts the updater container via `updates.register()`. |
| `src/types.ts`         | Hand-rolled mirror of signalk-container's API surface.               |
| `src/config/schema.ts` | TypeBox schema + `SCHEMA_DEFAULTS` (spread at `start()` time).       |
| `webapp/index.html`    | One-page redirect shell.                                             |
| `webapp/src/main.ts`   | Fetches `/api/gui-url`, redirects, fallback rendering.               |
| `vite.config.ts`       | Builds `webapp/` → `public/`, base `/signalk-updater/`.              |
| `tsconfig.json`        | Plugin TS → `plugin/`.                                               |
| `tsconfig.webapp.json` | Webapp TS typecheck only (vite handles emit).                        |

## Companion plugins (hard runtime dependencies)

- `signalk-container` — provides `globalThis.__signalk_containerManager` and the `updates.register()` API. Declared in `signalk.requires`. We do not add `peerDependencies` — npm's semver matching against signalk-container's prereleases is broken. We poll the global and surface a plugin error if it's never available.

The peer engine container (`signalk-updater-server`) is **not** a plugin dependency — its lifecycle is owned by systemd via the bash installer's Quadlet.
