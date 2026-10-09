// Full tier of the motion suite (`npm run test:motion`; CI job motion-suite in
// .github/workflows/ci.yml): the fast tier in test/motion/fast/ plus the long runs in
// test/motion/full/. See test/motion/README.md.
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from '../../vite.config.js'

export default mergeConfig(viteConfig, defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['test/motion/**/*.test.{js,mjs,ts,mts}'],
    environment: 'node',
    // Full-tier cases run for minutes each (README, Runtimes); the CI job's timeout is the real
    // limit.
    testTimeout: 30 * 60 * 1000
  }
}))
