import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config';

// Sandbox / live-preview overrides ONLY.
// The repo's own vite.config.ts is left untouched; this file just extends it.
//
//   host: '0.0.0.0'     -> listen on all interfaces so the preview proxy can reach Vite
//   allowedHosts: true  -> accept the generated preview hostname (*.e2b.app);
//                          Vite >= 6.0.9 otherwise answers "Blocked request. This host is not allowed."
//
// Do NOT use this for a real/public deployment.
export default mergeConfig(
  baseConfig,
  defineConfig({
    server: {
      host: '0.0.0.0',
      allowedHosts: true,
    },
  })
);
