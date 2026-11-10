import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { parseDevServerEnv, parseWebEnv } from './src/config/webEnvSchema.ts';

const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  parseWebEnv(loadEnv(mode, envDir, 'VITE_'));
  const viteEnv = loadEnv(mode, envDir, 'VITE_');
  const previewSample = viteEnv.VITE_APEX_PREVIEW_MODE === 'sample';
  const env = loadEnv(mode, envDir, '');
  const { PORT } = parseDevServerEnv(env);
  // An Apex Studio session has no API of its own. It sets this to the verified
  // runtime's API so the editable preview shows the same data as the build.
  const apiTarget = env.APEX_API_PROXY_TARGET?.trim() ?? '';
  const target = /^https?:\/\/[^\s]+$/.test(apiTarget)
    ? apiTarget
    : `http://localhost:${PORT}`;
  return {
    envDir,
    base: previewSample ? './' : '/',
    plugins: [react()],
    server: {
      proxy: {
        '/api': target,
        '/health': target,
      },
    },
  };
});
