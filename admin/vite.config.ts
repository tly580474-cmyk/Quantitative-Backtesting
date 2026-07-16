import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adminRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: adminRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5559,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5559,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(adminRoot, 'dist'),
    emptyOutDir: true,
  },
});
