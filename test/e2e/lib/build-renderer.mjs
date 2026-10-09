// node test/e2e/lib/build-renderer.mjs <outDir> <cacheDir>
//
// Builds the renderer with the repository's own vite.config.js, but into outDir and with vite's
// cache in cacheDir, so neither the repository's dist/ nor node_modules/.vite is touched. The config
// is imported directly (configFile: false) instead of being bundled by vite, which would write a
// temporary vite.config.js.timestamp-*.mjs file into the repository.
// Runs in its own process so that vite's esbuild service ends with it.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { REPO_ROOT } from './proc.mjs'

const [outDir, cacheDir] = process.argv.slice(2).map(p => p && path.resolve(p))
if (!outDir || !cacheDir) {
  console.error('usage: node build-renderer.mjs <outDir> <cacheDir>')
  process.exit(2)
}

const configEnv = { command: 'build', mode: 'production', isSsrBuild: false, isPreview: false }
const exported = (await import(pathToFileURL(path.join(REPO_ROOT, 'vite.config.js')).href)).default
const config = typeof exported === 'function' ? await exported(configEnv) : exported

await build({
  ...config,
  configFile: false,
  root: REPO_ROOT,
  mode: 'production',
  cacheDir,
  clearScreen: false,
  logLevel: 'warn',
  build: { ...config.build, outDir, emptyOutDir: true }
})
console.log(`built ${REPO_ROOT} -> ${outDir}`)
