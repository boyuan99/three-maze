// The render host's development page (test/render/host.html; plan item REN-9). It plays the part of
// the scene window around the host: it owns the canvas, its size and the window's frame timer, loads
// a shipped v0 maze through the v0 reference loader, and feeds the host poses as the motion worker
// will, about every 20 ms. The host itself (src/render) never touches the page.
//
//   ?maze=Hallway04   one of SHIPPED_MAZES (default Hallway04)
//   ?mode=walk        walk the corridor and back, looking left and right (default)
//   ?mode=still       stand at the start
//   ?mode=smoke       draw the canonical poses once, then run the frame loop for 1 s, and resolve
//                     window.renderHostSmoke with what was drawn (test/render/smoke.mjs)
//   ?dpr=1            the pixel ratio given to the host (default: the display's)
import type { V0SceneConfig } from '../../src/compat/v0/index.ts'
import { createRenderHost, hostV0Loaders, loadV0Content } from '../../src/render/index.ts'
import type { FrameScheduler, HostPose, RenderContent } from '../../src/render/index.ts'

declare global {
  interface Window {
    renderHostSmoke?: Promise<SmokeResult>
  }
}

export const SHIPPED_MAZES = ['Example01', 'Hallway01', 'Hallway02', 'Hallway04', 'HallwaySerialMigrated', 'Hallway_fog']

/** Offsets from the maze's start: x, z (scene units) and yaw (rad). Both ends of each corridor. */
export const CANONICAL_POSES: ReadonlyArray<{ dx: number, dz: number, yaw: number }> = [
  { dx: 0, dz: 0, yaw: 0 },
  { dx: 0, dz: -30, yaw: 0 },
  { dx: 0, dz: 30, yaw: Math.PI },
  { dx: 0, dz: 6, yaw: 0 },
  { dx: 2, dz: 0, yaw: Math.PI / 2 }
]

export interface PoseResult {
  pose: HostPose
  outcome: string
  calls: number
  triangles: number
  /** Share of pixels with a channel above 8 (of 255), mean colour, and a hash of the pixels */
  nonBlack: number
  meanRgb: [number, number, number]
  fnv1a: string
  /** The frame as a PNG data URL (first pose only) */
  png?: string
}

export interface SmokeResult {
  maze: string
  error?: string
  loadMs?: number
  webgl?: { renderer: string, vendor: string, version: string }
  assets?: RenderContent['assets']
  diagnostics?: string[]
  policy?: unknown
  info?: unknown
  poses?: PoseResult[]
  /** Frames the loop drew in 1 s on the window's requestAnimationFrame */
  loopFrames?: number
  /** colorSpace of every material's colour map, and point lights that still cast shadows */
  colorMapSpaces?: string[]
  pointLightShadows?: number
}

const params = new URLSearchParams(location.search)
const mazeName = params.get('maze') ?? 'Hallway04'
const mode = params.get('mode') ?? 'walk'
const pixelRatio = Number(params.get('dpr') ?? window.devicePixelRatio)
const canvas = document.getElementById('stimulus') as HTMLCanvasElement
const rafScheduler: FrameScheduler = {
  request: callback => requestAnimationFrame(callback),
  cancel: handle => cancelAnimationFrame(handle)
}

function canvasSize(): [number, number] {
  return [Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)]
}

async function loadMaze(name: string): Promise<RenderContent> {
  if (!SHIPPED_MAZES.includes(name)) throw new Error(`unknown maze '${name}': one of ${SHIPPED_MAZES.join(', ')}`)
  // As v0.3's scene store sets _basePath (src/stores/scenes.js:274): the maze's folder under the served root
  const [json, basePath] = name === 'Example01'
    ? ['/mazes/Example01.json', 'mazes/']
    : [`/mazes/${name}/${name}.json`, `mazes/${name}/`]
  const response = await fetch(json)
  if (!response.ok) throw new Error(`${json}: HTTP ${response.status}`)
  const config: V0SceneConfig = { ...(await response.json()), _basePath: basePath }
  return loadV0Content(config, hostV0Loaders())
}

function poseAt(start: RenderContent['start'], seq: number, offset: { dx: number, dz: number, yaw: number }): HostPose {
  return { seq, epoch: 0, t_dev_us: seq * 50_000, x: start.x + offset.dx, feetY: start.feetY, z: start.z + offset.dz, yaw: start.yaw + offset.yaw }
}

/**
 * The scripted walk, a sine every 20 s: from the start 50 units along -z, back through the start to
 * 50 units along +z and back to it; looking up to 0.6 rad left and right every 8 s
 */
function walkPose(start: RenderContent['start'], seq: number, tMs: number): HostPose {
  const t = tMs / 1000
  return {
    seq, epoch: 0, t_dev_us: Math.round(tMs * 1000), x: start.x, feetY: start.feetY,
    z: start.z - 50 * Math.sin((2 * Math.PI * t) / 20), yaw: start.yaw + 0.6 * Math.sin((2 * Math.PI * t) / 8)
  }
}

async function run(still: boolean) {
  const content = await loadMaze(mazeName)
  const [width, height] = canvasSize()
  const host = createRenderHost({ canvas, width, height, pixelRatio })
  host.setContent(content)
  const t0 = performance.now()
  let seq = 0
  // Poses arrive as messages, about every 20 ms, as the motion worker will send them
  const feed = () => {
    seq++
    host.handleMessage({ type: 'pose', pose: still ? poseAt(content.start, seq, CANONICAL_POSES[0]!) : walkPose(content.start, seq, performance.now() - t0) })
  }
  feed()
  setInterval(feed, 20)
  new ResizeObserver(() => {
    const [w, h] = canvasSize()
    host.handleMessage({ type: 'resize', width: w, height: h, pixelRatio })
  }).observe(canvas)
  host.start(rafScheduler)
  document.title = `Render host: ${mazeName}`
  console.info('render host', mazeName, JSON.stringify(host.info()))
}

function pixelStats(pixels: Uint8Array) {
  let lit = 0
  const sum = [0, 0, 0]
  let hash = 0x811c9dc5
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!
    const g = pixels[i + 1]!
    const b = pixels[i + 2]!
    if (r > 8 || g > 8 || b > 8) lit++
    sum[0] += r
    sum[1] += g
    sum[2] += b
  }
  for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i]!, 0x01000193)
  const n = pixels.length / 4
  return {
    nonBlack: lit / n,
    meanRgb: sum.map(value => +(value / n).toFixed(2)) as [number, number, number],
    fnv1a: (hash >>> 0).toString(16).padStart(8, '0')
  }
}

async function smoke(): Promise<SmokeResult> {
  const t0 = performance.now()
  const content = await loadMaze(mazeName)
  const loadMs = performance.now() - t0
  const [width, height] = canvasSize()
  const host = createRenderHost({ canvas, width, height, pixelRatio })
  const policy = host.setContent(content)
  const gl = host.renderer.getContext()
  const [bufferWidth, bufferHeight] = host.info().drawingBuffer
  const pixels = new Uint8Array(bufferWidth * bufferHeight * 4)
  const poses: PoseResult[] = []
  for (const [i, offset] of CANONICAL_POSES.entries()) {
    const pose = poseAt(content.start, i + 1, offset)
    host.setPose(pose)
    const frame = host.renderFrame()
    // Read back in the same task, before the frame is presented and the buffer cleared
    gl.readPixels(0, 0, bufferWidth, bufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const png = i === 0 ? canvas.toDataURL('image/png') : undefined
    const { calls, triangles } = host.info()
    poses.push({ pose, outcome: frame.outcome, calls, triangles, ...pixelStats(pixels), png })
  }

  host.setPose(poseAt(content.start, CANONICAL_POSES.length + 1, CANONICAL_POSES[0]!))
  const before = host.info().frames
  host.start(rafScheduler)
  await new Promise(resolve => setTimeout(resolve, 1000))
  host.stop()
  const info = host.info()

  const colorMapSpaces: string[] = []
  let pointLightShadows = 0
  content.scene.traverse(object => {
    const light = object as { isPointLight?: boolean, castShadow: boolean }
    if (light.isPointLight && light.castShadow) pointLightShadows++
    const material = (object as { material?: { map?: { colorSpace: string } | null } }).material
    if (material?.map) colorMapSpaces.push(material.map.colorSpace)
  })
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
  const webgl = {
    renderer: String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    vendor: String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    version: String(gl.getParameter(gl.VERSION))
  }
  const result: SmokeResult = {
    maze: mazeName, loadMs, webgl, assets: content.assets, diagnostics: content.diagnostics, policy, info, poses,
    loopFrames: info.frames - before, colorMapSpaces, pointLightShadows
  }
  host.dispose()
  return result
}

function showError(error: unknown) {
  const pre = document.createElement('pre')
  pre.textContent = `Render host (${mazeName}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`
  document.body.append(pre)
  console.error(error)
}

if (mode === 'smoke') {
  window.renderHostSmoke = smoke().catch(error => ({ maze: mazeName, error: error instanceof Error ? error.stack ?? error.message : String(error) }))
} else if (mode === 'walk' || mode === 'still') {
  run(mode === 'still').catch(showError)
} else {
  showError(new Error(`unknown mode '${mode}': walk, still or smoke`))
}
