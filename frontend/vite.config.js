import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5050', // Flask backend
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'simple-cube': resolve(__dirname, 'examples/simple-cube/index.html'),
        'api-controlled-cube': resolve(__dirname, 'examples/api-controlled-cube/index.html'),
      }
    }
  }
})