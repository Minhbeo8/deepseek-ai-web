import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const apiPort = process.env.API_PORT || '3001';

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: path.resolve(rootDir, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.VITE_PORT || 5173),
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.VITE_PORT || 5173),
    allowedHosts: true,
  },
});
