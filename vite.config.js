import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import agxOfflinePlugin from './vite.agx-offline.js';

export default defineConfig({
  // SPRINT-3D11.3 (R1): agxOfflinePlugin emite agx-precache.json y el
  // bundle del PUSH del Service Worker (offline-first de Ganadería).
  plugins: [react(), agxOfflinePlugin()],
  server: {
    host: '127.0.0.1',
    // LOTE 019-C (temporal): permite el Host publico del tunel Cloudflare Quick
    // Tunnel usado para la prueba E2E de Wompi Sandbox (redirectUrl https real).
    // El subdominio cambia en cada reinicio de cloudflared, por eso el wildcard.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
