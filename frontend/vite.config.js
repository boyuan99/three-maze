import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import * as path from 'node:path';
import config from '../config.json'; // Import the configuration

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@tmroot': path.resolve(__dirname, '../'),
    }
  },
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${config.flask.FLASK_RUN_PORT}/`,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/socket.io': {
        target: `http://localhost:${config.flask.FLASK_RUN_PORT}/`,
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'simple-cube': resolve(__dirname, 'examples/simple-cube/index.html'),
        'api-controlled-cube': resolve(__dirname, 'examples/api-controlled-cube/index.html'),
        'serial-port-maze-control': resolve(__dirname, 'mazes/straight-mazes/index.html'),
      }
    }
  }
})
