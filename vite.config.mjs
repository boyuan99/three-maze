import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                port: resolve(__dirname, 'port.html'),
                orbit: resolve(__dirname, 'orbit.html')
            }
        }
    },
    server: {
        open: false
    }
})
