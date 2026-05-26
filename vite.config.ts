import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// SignalK serves the built webapp at /signalk-updater/. `base` makes Vite
// emit asset URLs with that prefix so they resolve when the SignalK admin
// shell loads our remoteEntry.js from that path.
//
// Architecture: this webapp is a Module Federation remote consumed by the
// SignalK admin UI's Embedded route (/admin/#/e/Updater). The exposed
// ./AppPanel component is rendered inside the admin's main view while the
// sidebar stays visible — that's the whole reason we use Module Federation
// rather than shipping a standalone webapp.
//
// React is shared as a singleton so the admin shell and this remote share
// one React instance — hooks across the boundary would otherwise crash.
export default defineConfig({
  base: '/signalk-updater/',
  root: resolve(here, 'webapp'),
  plugins: [
    react(),
    federation({
      name: 'signalk-updater',
      filename: 'remoteEntry.js',
      exposes: {
        './AppPanel': resolve(here, 'webapp/src/AppPanel.tsx'),
      },
      shared: {
        // import: false on react/react-dom is load-bearing. Without it the
        // @module-federation/vite remote bundles its own copy of React into
        // _virtual_mf_..._loadShare__ chunks and unconditionally writes that
        // copy into the runtime cache (o.share.react) before the host's
        // share scope ever gets consulted. The result: two React instances
        // coexist, useState reads the host's dispatcher but our chunk's
        // React.useState returns null — "Cannot read properties of null
        // (reading 'useState')" at first paint.
        //
        // With import: false the build extracts named exports from our
        // devDep copy of React at build time but emits a deferred host-
        // provided import at runtime, so the SignalK admin's already-loaded
        // React is the only instance the panel ever touches. React/ReactDOM
        // 19 are still kept as devDeps so the build can scan their exports.
        react: { singleton: true, requiredVersion: '^19.0.0', import: false },
        'react-dom': { singleton: true, requiredVersion: '^19.0.0', import: false },
        // react/jsx-runtime (and the dev variant) must be import: true. The
        // SignalK admin doesn't pre-register these in its share scope — only
        // 'react' and 'react-dom' — so a deferred host-provider lookup throws
        // "Shared module 'react/jsx-runtime' must be provided by host". The
        // jsx-runtime modules are tiny self-contained factories (Fragment,
        // jsx, jsxs), don't import React internals, and bundling them adds
        // ~1 kB. The plugin would otherwise auto-share these sub-paths with
        // the same config as their parent 'react' entry (import: false),
        // which is exactly the broken behavior we're overriding here.
        'react/jsx-runtime': { singleton: true, requiredVersion: '^19.0.0', import: true },
        'react/jsx-dev-runtime': {
          singleton: true,
          requiredVersion: '^19.0.0',
          import: true,
        },
      },
      // We don't ship .d.ts to consumers — the SignalK admin loads us as a
      // runtime remote, not a type-imported package. Disabling avoids a
      // spurious "Cannot read file webapp/tsconfig.json" warning from the
      // dts-plugin (it looks for tsconfig.json adjacent to the entry).
      dts: false,
    }),
  ],
  build: {
    outDir: resolve(here, 'public'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    // Module Federation needs a known entry; rollup's preset for federation
    // handles entry naming internally via the plugin.
    modulePreload: false,
  },
});
