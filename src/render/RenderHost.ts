// The render host (ADR-0003 Decision 1c; plan item REN-9): draws the experiment scene into a canvas
// it is given, an HTMLCanvasElement in the scene window or an OffscreenCanvas in a worker. Size,
// pixel ratio, poses and render-state changes arrive as calls or as messages; the host owns the
// renderer, the scene graph and the camera. It never touches the window, the document, DOM events
// or Vue (src/render/tsconfig.json has no DOM library; test/frontend/render/domScan.test.ts), so the
// same code can move into a render worker (ADR-0003 Decision 3).
//
// The camera stands on the pose record: at its feet plus the eye height, turned by its yaw, with no
// other offset (ADR-0001 R1, R3; eyePose in src/motion/core.ts). Until content and a first pose
// arrive, and while the display is blanked, frames are cleared to black (D14 a) and still counted.
//
// Built on this host by later items: warm-up before ready and the post-ready compile monitor
// (REN-8), the presentation of stamped poses and render-state changes (REN-10: until then the
// newest pose is drawn and a change applies at the next frame), the frame log (REN-11) and the
// frame-clock check (REN-4).
import * as THREE from 'three'
import type { PoseRecord } from '../motion/core.ts'
import { checkProjection, disposeContent } from './content.ts'
import type { RenderContent } from './content.ts'
import {
  applyStimulusPolicy, BLANK_COLOR, checkSize, createStimulusRenderer, DEFAULT_STIMULUS_SETTINGS, describeRenderer
} from './renderer.ts'
import type { HostCanvas, RenderSettingValue, StimulusPolicyResult, StimulusSettings } from './renderer.ts'

/** Eye height above the feet without a rig file value: 3.7, the only validated one (ADR-0001 R3). */
export const DEFAULT_EYE_HEIGHT = 3.7

const POSE_NUMBERS = ['x', 'feetY', 'z', 'yaw'] as const
/** Whole numbers >= 0: the stamp that each frame drawn from the pose carries (ADR-0003 1a) */
const POSE_STAMP = ['seq', 'epoch', 't_dev_us'] as const

/** The part of a motion-core pose record the host draws from (src/motion/core.ts, PoseRecord) */
export type HostPose = Pick<PoseRecord, 'seq' | 'epoch' | 't_dev_us' | 'x' | 'feetY' | 'z' | 'yaw'>

/**
 * A render-state change (ADR-0003 1a), stamped with the sample it belongs to. display 'blank' shows
 * black and 'on' the world (experiment-file action `display`); freeze only marks the frames, since
 * the motion core stops the agent (action `freeze`).
 */
export interface RenderStateChange {
  seq?: number
  epoch?: number
  display?: 'blank' | 'on'
  freeze?: boolean
}

/** The host's inputs as messages, for a MessagePort or a worker */
export type HostMessage =
  | { type: 'pose', pose: HostPose }
  | { type: 'render_state', change: RenderStateChange }
  | { type: 'resize', width: number, height: number, pixelRatio: number }

/** requestAnimationFrame of the realm the host runs in, passed in: the host never names the frame timer */
export interface FrameScheduler {
  request(callback: (time: number) => void): number
  cancel(handle: number): void
}

/** What a frame drew: the scene, or black (blanked, no content yet, no pose yet) */
export type FrameOutcome = 'scene' | 'blank' | 'no_content' | 'no_pose'

/** One frame of the host. The same object is updated every frame: copy what must be kept. */
export interface FrameInfo {
  /** Index of the frame: 0 for the host's first, then +1 per frame */
  frame: number
  /** requestAnimationFrame timestamp, ms; null for a frame drawn outside the loop */
  tRafMs: number | null
  /** performance.now() when the frame started and ended, ms */
  tStartMs: number
  tEndMs: number
  outcome: FrameOutcome
  /** Stamp of the pose drawn; null when no pose was drawn */
  seq: number | null
  epoch: number | null
  tDevUs: number | null
  blank: boolean
  frozen: boolean
}

export interface RenderHostInfo {
  /** Drawing area in CSS pixels, and the drawing buffer in device pixels */
  size: [number, number]
  drawingBuffer: [number, number]
  pixelRatio: number
  eyeHeight: number
  /** Effective renderer settings by name (./renderer.ts, describeRenderer) */
  settings: Record<string, RenderSettingValue>
  /** Shader programs, textures and geometries on the GPU (renderer.info) */
  programs: number
  textures: number
  geometries: number
  /** Draw calls and triangles of the last frame that drew the scene */
  calls: number
  triangles: number
  frames: number
  /** What the stimulus policy changed in the content, or null before content */
  policy: StimulusPolicyResult | null
}

export interface RenderHostOptions {
  canvas: HostCanvas
  /** Drawing area in CSS pixels */
  width: number
  height: number
  /** Device pixels per CSS pixel, explicit (the scene window passes its display's ratio) */
  pixelRatio: number
  /** Eye height above the feet, from the rig file (ADR-0001 R3); default DEFAULT_EYE_HEIGHT */
  eyeHeight?: number
  /** Stimulus settings; the rest are DEFAULT_STIMULUS_SETTINGS (D7 a) */
  settings?: Partial<StimulusSettings>
  /** The renderer class; tests pass a stand-in, since Node has no WebGL */
  WebGLRenderer?: new (parameters: THREE.WebGLRendererParameters) => THREE.WebGLRenderer
}

export interface RenderHost {
  readonly renderer: THREE.WebGLRenderer
  readonly camera: THREE.PerspectiveCamera
  readonly settings: Readonly<StimulusSettings>
  readonly eyeHeight: number
  /** Whether the frame loop runs (start()) */
  readonly running: boolean
  /** Takes the content to draw (disposing of earlier content) and applies the stimulus policy */
  setContent(content: RenderContent): StimulusPolicyResult
  /** The newest pose: drawn from the next frame on (the host keeps a copy) */
  setPose(pose: HostPose): void
  setRenderState(change: RenderStateChange): void
  resize(width: number, height: number, pixelRatio?: number): void
  /** The calls above as messages: { type: 'pose' | 'render_state' | 'resize', ... } */
  handleMessage(message: HostMessage): void
  /** Draws one frame now; the frame loop calls it with the rAF timestamp */
  renderFrame(tRafMs?: number | null): Readonly<FrameInfo>
  /** Draws a frame on every callback of the scheduler until stop() */
  start(scheduler: FrameScheduler): void
  stop(): void
  info(): RenderHostInfo
  /** Stops the loop and frees the content and the renderer's GPU resources */
  dispose(): void
}

export function createRenderHost(options: RenderHostOptions): RenderHost {
  const settings: StimulusSettings = Object.freeze({ ...DEFAULT_STIMULUS_SETTINGS, ...options.settings })
  const eyeHeight = options.eyeHeight ?? DEFAULT_EYE_HEIGHT
  if (!(Number.isFinite(eyeHeight) && eyeHeight > 0)) throw new TypeError(`render host: eyeHeight must be > 0 (got ${eyeHeight})`)
  let width = options.width
  let height = options.height
  let pixelRatio = options.pixelRatio
  const renderer = createStimulusRenderer({
    canvas: options.canvas, width, height, pixelRatio, settings, WebGLRenderer: options.WebGLRenderer
  })
  const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000)

  let content: RenderContent | null = null
  let policy: StimulusPolicyResult | null = null
  let pose: HostPose | null = null
  let display: 'blank' | 'on' = 'on'
  let frozen = false
  const pending: RenderStateChange[] = []
  let frames = 0
  const frame: FrameInfo = {
    frame: -1, tRafMs: null, tStartMs: 0, tEndMs: 0, outcome: 'no_content',
    seq: null, epoch: null, tDevUs: null, blank: false, frozen: false
  }

  let scheduler: FrameScheduler | null = null
  let handle: number | null = null
  let running = false
  let disposed = false
  const alive = () => {
    if (disposed) throw new Error('render host: used after dispose()')
  }

  function setContent(next: RenderContent): StimulusPolicyResult {
    alive()
    checkProjection(next.projection)
    if (content && content.scene !== next.scene) disposeContent(content)
    content = next
    camera.fov = next.projection.fov
    camera.near = next.projection.near
    camera.far = next.projection.far
    camera.updateProjectionMatrix()
    policy = applyStimulusPolicy(next.scene, settings, renderer.capabilities.getMaxAnisotropy())
    return policy
  }

  function setPose(next: HostPose): void {
    alive()
    for (const key of POSE_NUMBERS) {
      if (!Number.isFinite(next[key])) throw new TypeError(`render host: pose ${key} must be a finite number (got ${next[key]})`)
    }
    for (const key of POSE_STAMP) {
      if (!Number.isSafeInteger(next[key]) || next[key] < 0) throw new TypeError(`render host: pose ${key} must be an integer >= 0 (got ${next[key]})`)
    }
    // A copy of what was checked: a caller that reuses its pose object cannot change it afterwards
    const { seq, epoch, t_dev_us, x, feetY, z, yaw } = next
    pose = { seq, epoch, t_dev_us, x, feetY, z, yaw }
  }

  function setRenderState(change: RenderStateChange): void {
    alive()
    if (change.display !== undefined && change.display !== 'blank' && change.display !== 'on') {
      throw new TypeError(`render host: display must be 'blank' or 'on' (got ${String(change.display)})`)
    }
    if (change.freeze !== undefined && typeof change.freeze !== 'boolean') {
      throw new TypeError(`render host: freeze must be true or false (got ${String(change.freeze)})`)
    }
    pending.push({ ...change })
  }

  function resize(nextWidth: number, nextHeight: number, nextPixelRatio = pixelRatio): void {
    alive()
    checkSize(nextWidth, nextHeight, nextPixelRatio)
    width = nextWidth
    height = nextHeight
    pixelRatio = nextPixelRatio
    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  function handleMessage(message: HostMessage): void {
    switch (message?.type) {
      case 'pose':
        setPose(message.pose)
        break
      case 'render_state':
        setRenderState(message.change)
        break
      case 'resize':
        resize(message.width, message.height, message.pixelRatio)
        break
      default:
        throw new TypeError(`render host: unknown message type ${JSON.stringify((message as { type?: unknown } | null)?.type)}`)
    }
  }

  function renderFrame(tRafMs: number | null = null): Readonly<FrameInfo> {
    alive()
    const tStartMs = performance.now()
    for (const change of pending) {
      if (change.display !== undefined) display = change.display
      if (change.freeze !== undefined) frozen = change.freeze
    }
    pending.length = 0

    const drawn = content && pose && display === 'on' ? pose : null
    if (drawn && content) {
      camera.position.set(drawn.x, drawn.feetY + eyeHeight, drawn.z)
      camera.rotation.set(0, drawn.yaw, 0)
      renderer.render(content.scene, camera)
    } else {
      // The clear colour may have been changed by a scene background colour: black is set each time
      renderer.setClearColor(BLANK_COLOR, 1)
      renderer.clear(true, true, true)
    }

    frame.frame = frames++
    frame.tRafMs = tRafMs
    frame.tStartMs = tStartMs
    frame.outcome = drawn ? 'scene' : !content ? 'no_content' : !pose ? 'no_pose' : 'blank'
    frame.seq = drawn ? drawn.seq : null
    frame.epoch = drawn ? drawn.epoch : null
    frame.tDevUs = drawn ? drawn.t_dev_us : null
    frame.blank = display === 'blank'
    frame.frozen = frozen
    frame.tEndMs = performance.now()
    return frame
  }

  const loop = (time: number) => {
    handle = null
    if (!running || !scheduler) return
    try {
      renderFrame(time)
    } catch (error) {
      running = false
      throw error
    }
    if (running) handle = scheduler.request(loop)
  }

  function start(next: FrameScheduler): void {
    alive()
    if (running) throw new Error('render host: the frame loop is already running')
    scheduler = next
    running = true
    handle = scheduler.request(loop)
  }

  function stop(): void {
    running = false
    if (handle !== null && scheduler) scheduler.cancel(handle)
    handle = null
  }

  function info(): RenderHostInfo {
    const buffer = renderer.getDrawingBufferSize(new THREE.Vector2())
    return {
      size: [width, height],
      drawingBuffer: [buffer.x, buffer.y],
      pixelRatio: renderer.getPixelRatio(),
      eyeHeight,
      settings: describeRenderer(renderer, settings),
      programs: renderer.info.programs?.length ?? 0,
      textures: renderer.info.memory.textures,
      geometries: renderer.info.memory.geometries,
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      frames,
      policy
    }
  }

  function dispose(): void {
    if (disposed) return
    stop()
    if (content) disposeContent(content)
    content = null
    renderer.dispose()
    disposed = true
  }

  return {
    renderer,
    camera,
    settings,
    eyeHeight,
    get running() { return running },
    setContent,
    setPose,
    setRenderState,
    resize,
    handleMessage,
    renderFrame,
    start,
    stop,
    info,
    dispose
  }
}
