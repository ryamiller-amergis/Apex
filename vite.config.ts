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
    include: ['pdfjs-dist'],
    exclude: ['pdfjs-dist/build/pdf.worker.mjs'],
  },
  worker: {
    format: 'es',
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
