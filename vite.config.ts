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
    // Nutrient is loaded via CDN UMD script (src/client/lib/nutrientViewer.ts),
    // not Vite ESM import — keep the package out of the dep optimizer.
    exclude: ['pdfjs-dist/build/pdf.worker.mjs', '@nutrient-sdk/viewer'],
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
