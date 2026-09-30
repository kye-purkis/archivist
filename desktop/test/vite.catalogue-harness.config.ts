import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({
  configFile:false,
  build:{
    target:'node24',
    ssr:'test/catalogue-electron-suite.ts',
    outDir:path.resolve(__dirname,'.catalogue-harness'),
    emptyOutDir:true,
    rollupOptions:{external:['electron','better-sqlite3'],output:{format:'cjs',entryFileNames:'suite.cjs'}},
  },
});
