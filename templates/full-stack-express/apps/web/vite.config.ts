import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { parseDevServerEnv, parseWebEnv } from './src/config/webEnvSchema.ts';

const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  parseWebEnv(loadEnv(mode, envDir, 'VITE_'));
  const { PORT } = parseDevServerEnv(loadEnv(mode, envDir, ''));
  const target = `http://localhost:${PORT}`;
  return {
    envDir,
    plugins: [react()],
    server: {
      proxy: {
        '/api': target,
        '/health': target,
      },
    },
  };
});
