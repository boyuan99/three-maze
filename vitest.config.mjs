// Vitest runs the unit tests in test/frontend/ and the fast tier of the motion suite in
// test/motion/fast/ (`npm test`). It shares the app's Vite settings (the `@` alias for src/, the Vue
// plugin) so tests resolve modules the way the app does.
// The full tier of the motion suite has its own configuration (test/motion/vitest.config.mjs,
// `npm run test:motion`). The end-to-end bench (test/e2e/, `npm run test:e2e`) and the backend tests
// (test/backend/) have their own runners and are not collected here.
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['test/frontend/**/*.test.{js,mjs,ts,mts}', 'test/motion/fast/**/*.test.{js,mjs,ts,mts}'],
    environment: 'node'
  }
}))
