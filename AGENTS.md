# signalk-updater

Thin-shell SignalK plugin that deep-links into the `signalk-updater-server` engine container. Mirrors the `signalk-backup` pattern.

## Architecture rules you must keep in mind

- **Adopt, don't manage.** Default `managedContainer: false`. The bash installer drops the systemd Quadlet for `signalk-updater-server`; this plugin only calls `updates.register()` to enroll for update notifications. Never `ensureRunning()` in the default path.
- **Never crash signalk-server.** On any failure (signalk-container missing, container not running, registration error), call `app.setPluginError(...)` — never throw out of `start()`.
- **Loose coupling.** Hand-rolled `src/types.ts` mirrors signalk-container's API surface. Never `import` signalk-container directly.
- **Spread schema defaults at start.** Signal K does not seed schema defaults at runtime; spread `SCHEMA_DEFAULTS` over the incoming config in `start()`. (See signalk-backup AGENTS.md "Gotchas".)
- **Webapp is an embedded panel, not a redirect shell.** Keyword `signalk-embeddable-webapp`. Built as a Vite Module Federation remote exposing `./AppPanel` (see `webapp/src/AppPanel.tsx`); the SignalK admin loads `/signalk-updater/remoteEntry.js` and renders us at `/admin/#/e/Updater` with its sidebar still visible — that's the whole point of going through Module Federation rather than a standalone `signalk-webapp`. The panel renders one full-height `<iframe>` pointing at the plugin's same-origin reverse proxy to the engine console (`/plugins/signalk-updater/console/`). React 19, shared as a singleton with the admin shell so hooks work across the boundary.
- **Same-origin proxy is non-negotiable for HTTPS/Traefik.** The proxy in `src/proxy.ts` forwards `/plugins/signalk-updater/console/*` → `http://localhost:3003/*` (the engine container). Without it, an HTTPS admin would try to iframe HTTP and trip mixed-content; behind a reverse proxy the cross-origin direct iframe would also break cookies/SSE. The proxy is SSE-aware (no response buffering on non-HTML responses) and injects `<meta name="api-base" content="/plugins/signalk-updater/console">` into HTML responses so the engine UI's `api.ts` knows to prefix its API calls.
- **Engine UI contract (cross-repo).** The engine (`signalk-updater-server`) must (a) build its Vite webapp with `base: './'` so its HTML emits relative asset URLs (otherwise `<script src="/assets/...">` bypasses the proxy and 404s against signalk-server's root), and (b) read `<meta name="api-base">` in its `api.ts` plus its two `EventSource` sites to prefix all paths. Changing the proxy mount path here means a coordinated engine release.
- **No `dangerouslySetInnerHTML`.** JSX escapes interpolated text by default; never reach for `dangerouslySetInnerHTML` in `AppPanel.tsx`. If you need rich error text, build it with React elements.
- **Ask the engine; don't mirror it.** The plugin no longer carries any plugin-side knowledge of which `signalk-updater-server` version is running. The engine Quadlet pins `:latest` (see signalk-universal-installer AGENTS.md "Engine images run on `:latest`"), so the `currentTag` passed to signalk-container's update comparator is the literal string `"latest"` — a floating tag the comparator treats as undefined-version on its own. The `currentVersion` callback HTTP-fetches `/api/health.version` on the engine to supply the honest RuntimeIdentity for the diff. This replaces an earlier model that hand-bumped a `UPDATER_SERVER_VERSION` constant on every engine release — it silently went stale, forced a plugin PR + release per engine release, and was the wrong layer to track engine version at. There's no plugin-side configuration for the engine tag anymore (`imageTag` config option removed) because there's nothing to configure: the Quadlet owns OperatorIntent, the engine owns RuntimeIdentity, GHCR owns LatestAvailable.

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

| Path                               | Purpose                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                     | Plugin entry. Adopts the updater container via `updates.register()`; mounts the console proxy under `registerWithRouter()`.                                                           |
| `src/proxy.ts`                     | SSE-aware HTTP reverse proxy to the engine container. Injects `<meta name="api-base">` into HTML responses. No response buffering on non-HTML so SSE streams pass through unbuffered. |
| `src/types.ts`                     | Hand-rolled mirror of signalk-container's API surface.                                                                                                                                |
| `src/config/schema.ts`             | TypeBox schema + `SCHEMA_DEFAULTS` (spread at `start()` time).                                                                                                                        |
| `webapp/src/AppPanel.tsx`          | Module-Federation-exposed React component. Probes the plugin info endpoint, then renders a full-height `<iframe>` of `/plugins/signalk-updater/console/`.                             |
| `vite.config.ts`                   | Vite + `@vitejs/plugin-react` + `@module-federation/vite`. Exposes `./AppPanel`, shares React/ReactDOM as singletons. Builds `webapp/` → `public/`, base `/signalk-updater/`.         |
| `tsconfig.json`                    | Plugin TS → `plugin/`.                                                                                                                                                                |
| `tsconfig.webapp.json`             | Webapp TS typecheck only (vite handles emit). `jsx: react-jsx`.                                                                                                                       |
| `.coderabbit.yaml`                 | CodeRabbit review config — encodes the rules above so PR reviews don't re-litigate them.                                                                                              |
| `.github/workflows/signalk-ci.yml` | Calls the shared SignalK plugin-ci workflow with `format-check-command: npm run ci-lint` wired in.                                                                                    |
| `.github/workflows/publish.yml`    | Tag-triggered npm publish (`v*` → `npm publish`).                                                                                                                                     |

## Companion plugins (hard runtime dependencies)

- `signalk-container` — provides `globalThis.__signalk_containerManager` and the `updates.register()` API. Declared in `signalk.requires`. We do not add `peerDependencies` — npm's semver matching against signalk-container's prereleases is broken. We poll the global and surface a plugin error if it's never available.

The peer engine container (`signalk-updater-server`) is **not** a plugin dependency — its lifecycle is owned by systemd via the bash installer's Quadlet.
