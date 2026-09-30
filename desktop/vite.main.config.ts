import { defineConfig } from 'vite';
// Keep the SDK package intact so its runtime/native asset discovery remains
// relative to its installed package in development and in the packaged app.
export default defineConfig({ build: { rollupOptions: { external: ['better-sqlite3', '@github/copilot-sdk'] } } });
