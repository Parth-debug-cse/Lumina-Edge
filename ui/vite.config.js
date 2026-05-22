// Vite config for Lumina Edge UI — React + dev proxy to Express API gateway
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// API port: default 8090, overridable via LUMINA_API_PORT env var
const API_PORT = process.env.LUMINA_API_PORT || 8090;

export default defineConfig({
  plugins: [react()],
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
