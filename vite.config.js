import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5600, proxy: { '/api': 'http://localhost:4600', '/v1': 'http://localhost:4600' } },
  plugins: [react()],
});
