import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/super-penallity/',
  publicDir: false,
  build: {
    outDir: '.',
    assetsDir: '',
    emptyOutDir: false,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})

