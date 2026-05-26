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
        react: { singleton: true, requiredVersion: '^19.0.0' },
        'react-dom': { singleton: true, requiredVersion: '^19.0.0' },
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
