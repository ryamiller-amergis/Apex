import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { parseDevServerEnv, parseWebEnv } from './src/config/webEnvSchema.ts';

const currentDir =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : import.meta.url.startsWith('file:')
      ? path.dirname(fileURLToPath(import.meta.url))
      : process.cwd();
const envDir = path.resolve(currentDir, '../..');
const uiSourceEntry = path.resolve(
  currentDir,
  '../../packages/ui/src/index.ts'
);

export default defineConfig(({ command, mode }) => {
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
  const useSourceUiAlias = command === 'serve' || mode === 'development';
  return {
    envDir,
    base: previewSample ? './' : '/',
    plugins: [react()],
    resolve: useSourceUiAlias
      ? {
          alias: {
            '@project-scope/ui': uiSourceEntry,
          },
        }
      : undefined,
    server: {
      proxy: {
        '/api': target,
        '/health': target,
      },
    },
  };
});
