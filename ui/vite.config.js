// Vite config for Lumina Edge UI — React + dev proxy to Express API gateway
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// API port: default 8090, overridable via LUMINA_API_PORT env var
const API_PORT = process.env.LUMINA_API_PORT || 8090;

function productionAssetCaching() {
  return {
    name: 'lumina-production-asset-cache',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0];
        if (pathname.startsWith('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (pathname === '/' || pathname.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), productionAssetCaching()],
  build: {
    cssCodeSplit: true,
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy /api/* requests to the Express API gateway (bypasses CORS)
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      }
    },
  },
})
