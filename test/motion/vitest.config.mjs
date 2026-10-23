// Full tier of the motion suite (`npm run test:motion`; CI job motion-suite in
// .github/workflows/ci.yml): the fast tier in test/motion/fast/ plus the long runs in
// test/motion/full/. See test/motion/README.md.
import { availableParallelism } from 'node:os'
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
    testTimeout: 30 * 60 * 1000,
    // One test file per logical CPU. Vitest's default leaves one CPU to its main process, which
    // only waits while the files run their synchronous Rapier calls: on a hosted runner with 2 or 4
    // CPUs that default runs 1 or 3 files at a time (README, Runtimes).
    maxWorkers: availableParallelism()
  }
}))
