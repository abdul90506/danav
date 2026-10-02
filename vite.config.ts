import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Keep the API proxy target in sync with the backend port. `npm run dev`
// starts the backend with the same PORT value, so overriding PORT does not
// silently leave the frontend pointing at a dead port.
const backendPort = process.env.PORT || '3001';
const frontendPort = Number(process.env.VITE_PORT) || 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    port: frontendPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
      },
    },
  },
});
