import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/manage/',
  publicDir: '../../assets',
  plugins: [react()],
  server: { port: 5173, host: '0.0.0.0', proxy: { '/api': { target: process.env.VITE_PROXY_TARGET || 'http://localhost:4000', changeOrigin: false, secure: false } } },
});
