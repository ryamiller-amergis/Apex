import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  publicDir: '../../public',
  envDir: '../../',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  optimizeDeps: {
    // Windows dev uses esbuild-wasm (scripts/patch-esbuild-wasm.js), which has a
    // 32-bit memory ceiling; source maps for the full dependency set exceed it.
    esbuildOptions: {
      sourcemap: false,
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
