import { defineConfig, mergeConfig } from 'vite';
import path from 'node:path';
import base from '../../vite.config';

const shim = path.resolve(__dirname, 'shim.ts');
export default mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: 'lab-shim',
        enforce: 'pre',
        resolveId(source, importer) {
          if (source === '../world/TestRoom' && importer && importer.endsWith('src/game/Game.ts')) return shim;
          return null;
        },
      },
    ],
    build: { outDir: 'tools/_tmp_lab/dist', emptyOutDir: true },
  }),
);
