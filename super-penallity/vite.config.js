import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Собранное приложение лежит в /super-penallity/dist/ — иначе в корне остаётся старый захардкоженный бандл.
  base: '/super-penallity/dist/',
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
