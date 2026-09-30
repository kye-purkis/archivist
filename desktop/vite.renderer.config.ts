import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
export default defineConfig(({ command }) => ({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  // Vite's development React preamble needs a nonce under the renderer CSP.
  html: command === 'serve' ? { cspNonce: 'tt001-vite-development' } : {},
  plugins: [react(), tailwindcss(), {
    name: 'diagnostic-development-csp',
    transformIndexHtml(html) {
      return command === 'serve'
        ? html.replace("script-src 'self';", "script-src 'self' 'nonce-tt001-vite-development';")
          .replace("connect-src 'self' http://127.0.0.1:5178;", "connect-src 'self' ws://127.0.0.1:*;")
        : html;
    },
  }],
  build: { outDir: path.resolve(__dirname, '.vite/renderer/main_window'), emptyOutDir: true },
  resolve: { alias: { '@': path.resolve(__dirname, 'src/renderer') } },
  server: { host: '127.0.0.1', port: 5178 },
}));
