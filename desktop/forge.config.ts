import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { MakerZIP } from '@electron-forge/maker-zip';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // The Vite plugin defaults to retaining only /.vite, which strips runtime
    // dependencies (including better-sqlite3) from the packaged application.
    // Keep only compiled output, the manifest and production dependencies;
    // Electron Packager prunes devDependencies and AutoUnpackNativesPlugin
    // places native .node binaries outside the asar archive.
    ignore: (file) => {
      if (!file) return false;
      return ![
        '/package.json',
        '/.vite',
        '/node_modules',
      ].some((path) => file === path || file.startsWith(`${path}/`));
    },
  },
  rebuildConfig: { force: true },
  makers: [new MakerZIP({})],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
  ],
};
export default config;
