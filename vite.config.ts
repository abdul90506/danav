import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Keep the API proxy target in sync with the backend port. `npm run dev`
// starts the backend with the same PORT value, so overriding PORT does not
// silently leave the frontend pointing at a dead port.
const backendPort = process.env.PORT || '3001';
const frontendPort = Number(process.env.VITE_PORT) || 5173;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        /**
         * Keep the three heavy, rarely-changing libraries in their own files.
         *
         * Everything the app imports used to land in one 620 kB bundle, so every
         * change to any component invalidated the whole download — including the
         * syntax highlighter, which is by far the largest thing here. Split out,
         * they are fetched in parallel the first time and then served from cache
         * across releases, and the app's own code stays small enough to audit.
         */
        manualChunks: {
          react: ['react', 'react-dom'],
          markdown: ['react-markdown', 'remark-gfm'],
          prism: [
            'prismjs',
            'prismjs/components/prism-javascript',
            'prismjs/components/prism-typescript',
            'prismjs/components/prism-jsx',
            'prismjs/components/prism-tsx',
            'prismjs/components/prism-python',
            'prismjs/components/prism-json',
            'prismjs/components/prism-bash',
            'prismjs/components/prism-markdown',
            'prismjs/components/prism-sql',
            'prismjs/components/prism-css',
            'prismjs/components/prism-yaml',
            'prismjs/components/prism-c',
            'prismjs/components/prism-cpp',
            'prismjs/components/prism-csharp',
            'prismjs/components/prism-java',
            'prismjs/components/prism-rust',
            'prismjs/components/prism-go',
          ],
        },
      },
    },
    chunkSizeWarningLimit: 400,
  },
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
