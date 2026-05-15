import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { DEFAULT_DEV_PORT } from '../server/default-port.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Same PORT as server/.env so changing PORT doesn't break the WS proxy. */
export default defineConfig(({ mode }) => {
  const serverDir = path.join(__dirname, '..', 'server');
  const env = loadEnv(mode, serverDir, '');
  const apiPort = env.PORT || String(DEFAULT_DEV_PORT);

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
        '/ws': {
          target: `ws://localhost:${apiPort}`,
          ws: true,
        },
      },
    },
  };
});
