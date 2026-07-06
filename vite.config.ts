import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5432,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5432,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 1300,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react-dom') || (id.includes('node_modules/react') && !id.includes('node_modules/react-router'))) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design')) {
            return 'vendor-antd';
          }
          if (id.includes('node_modules/lightweight-charts')) {
            return 'vendor-charts';
          }
          if (id.includes('node_modules/@xyflow') || id.includes('node_modules/dagre')) {
            return 'vendor-flow';
          }
          if (id.includes('node_modules/xlsx') || id.includes('node_modules/dexie')) {
            return 'vendor-data';
          }
        },
      },
    },
  },
});
