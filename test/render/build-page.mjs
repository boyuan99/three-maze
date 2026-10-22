// node test/render/build-page.mjs <outDir> <cacheDir>
//
// Builds the render host's development page (test/render/host.html) with the repository's
// vite.config.js into outDir (the page at outDir/test/render/host.html, public/ copied beside it, so
// the mazes are served at /mazes/), with vite's cache in cacheDir: neither dist/ nor
// node_modules/.vite is touched. As test/e2e/lib/build-renderer.mjs, it imports the config directly
// and runs in its own process, so that vite's esbuild service ends with it.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { REPO_ROOT } from '../e2e/lib/proc.mjs'

const [outDir, cacheDir] = process.argv.slice(2).map(p => p && path.resolve(p))
if (!outDir || !cacheDir) {
  console.error('usage: node test/render/build-page.mjs <outDir> <cacheDir>')
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
  build: {
    ...config.build,
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 2048, // three.js alone is about 1.3 MB minified
    rollupOptions: { input: path.join(REPO_ROOT, 'test', 'render', 'host.html') }
  }
})
console.log(`built test/render/host.html -> ${outDir}`)
