import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// SignalK mounts the built webapp at /signalk-updater/. `base` makes Vite emit
// asset URLs with that prefix so they resolve when served behind it.
export default defineConfig({
  base: '/signalk-updater/',
  root: resolve(here, 'webapp'),
  build: {
    outDir: resolve(here, 'public'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
