import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.VITE_BACKEND_URL ?? 'http://localhost:4000';

// In dev, proxy REST + WebSocket to the backend so the app uses same-origin relative URLs everywhere
// (identical to production, where nginx does the same proxying).
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 700, // recharts is the single large dependency, isolated in its own cacheable chunk
    rollupOptions: { output: { manualChunks: { charts: ['recharts'] } } },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
      '/hooks': { target, changeOrigin: true }, // built-in webhook test sink
    },
  },
});
