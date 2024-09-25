import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig(({ command }) => {
  const isProduction = command === 'build'
  return {
    root: path.resolve(__dirname, ''),
    base: isProduction ? '/static/dist/' : '/',
    build: {
      outDir: path.resolve(__dirname, 'dist'),
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(__dirname, 'src', 'main.js'),
        output: {
          entryFileNames: 'js/[name].js',
          chunkFileNames: 'js/[name].js',
          assetFileNames: 'assets/[name].[ext]'
        }
      }
    },
    server: {
      proxy: {
        '/api': 'http://localhost:5000',
        '/get_rotation': 'http://localhost:5000'
      }
    }
  }
})