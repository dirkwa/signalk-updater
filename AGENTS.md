# signalk-updater

Thin-shell SignalK plugin that deep-links into the `signalk-updater-server` engine container. Mirrors the `signalk-backup` pattern.

## Architecture rules you must keep in mind

- **Adopt, don't manage.** Default `managedContainer: false`. The bash installer drops the systemd Quadlet for `signalk-updater-server`; this plugin only calls `updates.register()` to enroll for update notifications. Never `ensureRunning()` in the default path.
- **Never crash signalk-server.** On any failure (signalk-container missing, container not running, registration error), call `app.setPluginError(...)` — never throw out of `start()`.
- **Loose coupling.** Hand-rolled `src/types.ts` mirrors signalk-container's API surface. Never `import` signalk-container directly.
- **Spread schema defaults at start.** Signal K does not seed schema defaults at runtime; spread `SCHEMA_DEFAULTS` over the incoming config in `start()`. (See signalk-backup AGENTS.md "Gotchas".)
- **Webapp is a redirect shell.** No React. Vanilla TS that fetches `/api/gui-url`, then `window.location.replace`s. If the updater container is unreachable, render a clear "use signalk-recovery" fallback (CC-3).
- **Webapp inherits the SignalK admin theme.** `webapp/index.html` fetches `/admin/.vite/manifest.json` and injects the admin UI's content-hashed stylesheets into `<head>` before importing `src/main.ts`. This is what gives the page Bootstrap utility classes and host light/dark theming without bundling a CSS framework. Don't replace this with a static `<link>` (the admin filenames are content-hashed) and don't add a CSS framework dependency.
- **Escape values before `innerHTML`.** Any value that flows from `fetch()` responses or browser errors into `element.innerHTML` MUST go through `escapeHtml(...)` in `webapp/src/main.ts`. The XSS surface is small but real.
- **Ask the engine; don't mirror it.** The plugin no longer carries any plugin-side knowledge of which `signalk-updater-server` version is running. The engine Quadlet pins `:latest` (see signalk-universal-installer AGENTS.md "Engine images run on `:latest`"), so the `currentTag` passed to signalk-container's update comparator is the literal string `"latest"` — a floating tag the comparator treats as undefined-version on its own. The `currentVersion` callback HTTP-fetches `/api/health.version` on the engine to supply the honest RuntimeIdentity for the diff. This replaces an earlier model that hand-bumped a `UPDATER_SERVER_VERSION` constant on every engine release — it silently went stale, forced a plugin PR + release per engine release, and was the wrong layer to track engine version at. There's no plugin-side configuration for the engine tag any more (`imageTag` config option removed) because there's nothing to configure: the Quadlet owns OperatorIntent, the engine owns RuntimeIdentity, GHCR owns LatestAvailable.

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
cr review --plain | tee cr-review-<branch>.txt
```

Save the cr output to a repo-local file (the repo `.gitignore`s `cr-review*.txt`); `cr` is rate-limited so reruns are expensive. Skip `cr review` only for `chore(release): X.Y.Z` PRs.

### Release flow

Tag `vX.Y.Z` triggers `.github/workflows/publish.yml` which runs `npm publish --provenance --access public` to npmjs. Pre-release tags (`vX.Y.Z-beta.N`, `vX.Y.Z-rc.N`) publish under the `beta` dist-tag. Never publish without explicit approval.

## TypeScript

- `"type": "module"`, ESM throughout. Relative imports use `.js` suffix (NodeNext resolution).
- Both `tsconfig.json` and `tsconfig.webapp.json` run with the full strict-TS set: `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`. Code must narrow against `undefined` when reading array slots or record entries.
- `@typescript-eslint/no-explicit-any` is `error` (not `warn`) — `any` fails CI, not just lint output.

## File layout

| Path                               | Purpose                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                     | Plugin entry. Adopts the updater container via `updates.register()`.                                           |
| `src/types.ts`                     | Hand-rolled mirror of signalk-container's API surface.                                                         |
| `src/config/schema.ts`             | TypeBox schema + `SCHEMA_DEFAULTS` (spread at `start()` time).                                                 |
| `webapp/index.html`                | Redirect shell entry. Inline `<script>` injects the SignalK admin CSS before importing `src/main.ts`.          |
| `webapp/src/main.ts`               | Fetches `/api/gui-url`, redirects, fallback rendering. `escapeHtml(...)` guards any `innerHTML` interpolation. |
| `vite.config.ts`                   | Builds `webapp/` → `public/`, base `/signalk-updater/`.                                                        |
| `tsconfig.json`                    | Plugin TS → `plugin/`.                                                                                         |
| `tsconfig.webapp.json`             | Webapp TS typecheck only (vite handles emit).                                                                  |
| `.coderabbit.yaml`                 | CodeRabbit review config — encodes the rules above so PR reviews don't re-litigate them.                       |
| `.github/workflows/signalk-ci.yml` | Calls the shared SignalK plugin-ci workflow with `format-check-command: npm run ci-lint` wired in.             |
| `.github/workflows/publish.yml`    | Tag-triggered npm publish (`v*` → `npm publish`).                                                              |

## Companion plugins (hard runtime dependencies)

- `signalk-container` — provides `globalThis.__signalk_containerManager` and the `updates.register()` API. Declared in `signalk.requires`. We do not add `peerDependencies` — npm's semver matching against signalk-container's prereleases is broken. We poll the global and surface a plugin error if it's never available.

The peer engine container (`signalk-updater-server`) is **not** a plugin dependency — its lifecycle is owned by systemd via the bash installer's Quadlet.
