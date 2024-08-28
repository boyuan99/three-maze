import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                development: resolve(__dirname, 'development.html')
            }
        }
    },
    server: {
        open: '/index.html'
    }
})
