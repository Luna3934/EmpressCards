// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

// Use `--mode web` when building for GitHub Pages
export default defineConfig(({ mode }) => {
  const isWeb = mode === 'web'; // run: vite build --mode web

  return {
    plugins: [react()],
    base: '/',
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? { protocol: 'ws', host, port: 1421 }
        : undefined,
      watch: { ignored: ['**/src-tauri/**'] },
    },
  };
});
