// Electron smoke test of the render host (plan item REN-9): the six shipped mazes drawn through
// src/render, in Electron 44.7.0, without a visible window.
//
//   npm run test:render                     all six mazes
//   node test/render/smoke.mjs --only Hallway04,Hallway02 [--software-gl] [--out DIR]
//                              [--no-wait] [--lock-wait S]
//
// It builds the development page (test/render/host.html) into a fresh folder, serves it on a free
// port and runs test/render/smoke-main.cjs, which loads each maze in a hidden offscreen window and
// records what the host drew. It takes the bench lock (test/e2e/lib/benchLock.mjs) shared: it uses
// no fixed port, so it may run beside other functional runs, never during a timing measurement.
//
// Checks per maze: no page error, console error or crashed renderer; every asset loaded; the
// effective renderer settings (owner decision D7 a: no tone mapping, sRGB output, no shadows, the
// pixel ratio given, the high-performance GPU asked for); colour textures sRGB and no point-light
// shadows; each canonical pose drew the scene (not black for want of content or pose), and at
// least one pose made draw calls and drew something other than black on a tenth of the frame (from
// the start, Example01's small room shows only a strip of floor); the frame loop ran on the
// window's requestAnimationFrame. Output: results.json and <maze>.png (the first canonical pose)
// in the output folder.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireBenchLock, BenchBusyError } from '../e2e/lib/benchLock.mjs'
import { childEnv, electronPath, REPO_ROOT, runToEnd, startLogged, stopAll, stopTree, waitExit } from '../e2e/lib/proc.mjs'
import { serveDir } from '../e2e/lib/static-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SHIPPED_MAZES = ['Example01', 'Hallway01', 'Hallway02', 'Hallway04', 'HallwaySerialMigrated', 'Hallway_fog']
/** The page runs at 1280 x 720 CSS pixels and pixel ratio 1 (smoke-main.cjs) */
export const DRAWING_BUFFER = [1280, 720]
export const EXPECTED_SETTINGS = {
  toneMapping: 'NoToneMapping',
  toneMappingExposure: 1,
  outputColorSpace: 'srgb',
  colorManagement: true,
  shadows: false,
  pixelRatio: 1,
  clearColor: 0,
  clearAlpha: 1,
  'context.powerPreference': 'high-performance'
}
/** At least one canonical pose must draw something other than black on this share of the frame */
export const MIN_LIT_SHARE = 0.1
/** Frames the loop must draw in its second on requestAnimationFrame */
export const MIN_LOOP_FRAMES = 10

function parseArgs (argv) {
  const a = { only: null, softwareGl: false, out: null, noWait: false, lockWait: 3600 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--only') a.only = argv[++i]
    else if (arg === '--software-gl') a.softwareGl = true
    else if (arg === '--out') a.out = argv[++i]
    else if (arg === '--no-wait') a.noWait = true
    else if (arg === '--lock-wait') a.lockWait = Number(argv[++i])
    else { console.error(`unknown argument ${arg}`); process.exit(2) }
  }
  return a
}

/** The failures of one maze's result, as lines; none means it passed */
export function checkMaze (result) {
  const failures = []
  if (result.error) failures.push(`page error: ${String(result.error).split('\n')[0]}`)
  if (result.renderProcessGone) failures.push(`renderer process gone: ${JSON.stringify(result.renderProcessGone)}`)
  const errors = (result.consoleMessages || []).filter(m => m.level === 'error')
  if (errors.length) failures.push(`${errors.length} console error(s), first: ${errors[0].message.split('\n')[0]} (${errors[0].source})`)
  if (result.error) return failures

  const notLoaded = result.assets.filter(asset => !asset.loaded)
  if (notLoaded.length) failures.push(`assets not loaded: ${notLoaded.map(asset => asset.url).join(', ')}`)
  for (const [name, expected] of Object.entries(EXPECTED_SETTINGS)) {
    if (result.info.settings[name] !== expected) failures.push(`setting ${name} is ${JSON.stringify(result.info.settings[name])}, expected ${JSON.stringify(expected)}`)
  }
  if (result.info.drawingBuffer.join('x') !== DRAWING_BUFFER.join('x')) {
    failures.push(`drawing buffer ${result.info.drawingBuffer.join('x')}, expected ${DRAWING_BUFFER.join('x')}`)
  }
  if (!(result.info.programs > 0)) failures.push('no shader program was compiled')
  const notSrgb = result.colorMapSpaces.filter(space => space !== 'srgb')
  if (notSrgb.length) failures.push(`colour textures not sRGB: ${notSrgb.join(', ')}`)
  if (result.pointLightShadows !== 0) failures.push(`${result.pointLightShadows} point light(s) cast shadows`)
  for (const pose of result.poses) {
    if (pose.outcome !== 'scene') failures.push(`pose seq ${pose.pose.seq} drew ${pose.outcome}, not the scene`)
  }
  if (!result.poses.some(pose => pose.calls > 0)) failures.push('no canonical pose made a draw call')
  const lit = Math.max(...result.poses.map(pose => pose.nonBlack))
  if (!(lit >= MIN_LIT_SHARE)) failures.push(`no canonical pose drew more than ${(100 * lit).toFixed(1)} % of the frame (need ${100 * MIN_LIT_SHARE} %)`)
  if (!(result.loopFrames >= MIN_LOOP_FRAMES)) failures.push(`the frame loop drew ${result.loopFrames} frame(s) in 1 s (need ${MIN_LOOP_FRAMES})`)
  return failures
}

function summary (result) {
  if (result.error) return ''
  const lit = Math.max(...result.poses.map(pose => pose.nonBlack))
  const calls = result.poses.map(pose => pose.calls).join('/')
  return `loaded in ${Math.round(result.loadMs)} ms; draw calls ${calls}; ${result.info.programs} programs, ` +
    `${result.info.textures} textures; up to ${(100 * lit).toFixed(0)} % of the frame drawn; ` +
    `loop ${result.loopFrames} frames/s; assets ${result.assets.filter(a => a.loaded).length}/${result.assets.length}`
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const mazes = args.only ? args.only.split(',').map(s => s.trim()).filter(Boolean) : SHIPPED_MAZES
  for (const maze of mazes) {
    if (!SHIPPED_MAZES.includes(maze)) { console.error(`unknown maze ${maze}: one of ${SHIPPED_MAZES.join(', ')}`); process.exit(2) }
  }
  let lock
  try {
    lock = await acquireBenchLock({
      mode: 'shared', purpose: `test/render/smoke.mjs ${mazes.join(',')}`, wait: !args.noWait, timeoutS: args.lockWait,
      log: message => console.error(`render smoke: ${message}`)
    })
  } catch (error) {
    if (error instanceof BenchBusyError) { console.error(`render smoke: ${error.message}`); process.exit(2) }
    throw error
  }

  const outDir = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'three-maze-render-smoke-'))
  fs.mkdirSync(outDir, { recursive: true })
  fs.rmSync(path.join(outDir, 'results.json'), { force: true })
  const siteDir = path.join(outDir, 'site')
  console.log(`render smoke: ${mazes.join(', ')}${args.softwareGl ? ' (SwiftShader)' : ''}; output ${outDir}`)

  const built = await runToEnd('build page', process.execPath, [path.join(HERE, 'build-page.mjs'), siteDir, path.join(outDir, 'vite-cache')],
    { timeoutMs: 180000, logFile: path.join(outDir, 'build.log') })
  if (built.code !== 0) {
    console.error(`render smoke: building the page failed (exit ${built.code}); see ${path.join(outDir, 'build.log')}`)
    process.exit(1)
  }
  const server = await serveDir(siteDir)
  let electron
  try {
    electron = startLogged('electron', electronPath(), [path.join(HERE, 'smoke-main.cjs')], {
      logFile: path.join(outDir, 'electron.log'),
      env: childEnv({ APP_URL: server.url, OUT_DIR: outDir, MAZES: mazes.join(','), SMOKE_SOFTWARE_GL: args.softwareGl ? '1' : '0' })
    })
    const timeoutMs = (30 + 60 * mazes.length) * 1000
    if (!(await waitExit(electron, timeoutMs))) {
      stopTree(electron)
      console.error(`render smoke: Electron did not finish within ${timeoutMs / 1000} s; stopped it`)
    }
  } finally {
    await server.close()
    lock.release()
  }

  const resultsFile = path.join(outDir, 'results.json')
  if (!fs.existsSync(resultsFile)) {
    console.error(`render smoke: no results.json; see ${path.join(outDir, 'electron.log')}`)
    process.exit(1)
  }
  const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8'))
  let failed = 0
  console.log(`Electron ${results.electron} (Chrome ${results.chrome}); WebGL ${results.mazes.find(m => m.webgl)?.webgl?.renderer ?? '?'}`)
  for (const result of results.mazes) {
    const failures = checkMaze(result)
    result.failures = failures
    if (failures.length) failed++
    console.log(`  ${failures.length ? 'FAIL' : 'PASS'} ${result.maze.padEnd(22)} ${summary(result)}`)
    for (const line of failures) console.log(`       ${line}`)
    // Electron's warning that the test page sets no Content-Security-Policy is not about the host
    const warnings = (result.consoleMessages || []).filter(m => m.level === 'warning' && !/Electron Security Warning/.test(m.message))
    for (const warning of warnings) console.log(`       warning: ${warning.message.split('\n')[0]} (${warning.source})`)
  }
  results.lock = lock.record()
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2))
  console.log(`${failed ? 'FAILED' : 'PASSED'}: ${results.mazes.length - failed}/${results.mazes.length} mazes; details in ${resultsFile}`)
  process.exit(failed ? 1 : 0)
}

process.on('SIGINT', () => {
  stopAll()
  process.exit(130)
})
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    stopAll()
    console.error(error)
    process.exit(1)
  })
}
