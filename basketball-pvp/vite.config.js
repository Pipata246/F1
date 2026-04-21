import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/basketball-pvp/',
  publicDir: false,
  build: {
    outDir: 'public',
    assetsDir: '',
    emptyOutDir: false,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3002',
    },
  },
})
