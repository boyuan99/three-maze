// Vitest runs the unit tests in test/frontend/ (`npm test`). It shares the app's Vite settings
// (the `@` alias for src/, the Vue plugin) so tests resolve modules the way the app does.
// The end-to-end bench (test/e2e/, `npm run test:e2e`) and the backend tests (test/backend/)
// have their own runners and are not collected here.
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['test/frontend/**/*.test.{js,mjs,ts,mts}'],
    environment: 'node'
  }
}))
