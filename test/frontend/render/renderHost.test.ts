// The render host (src/render, plan item REN-9) on a stand-in renderer: its settings, its camera,
// what each frame draws, its inputs as calls and messages, and its frame loop. What the GPU draws
// is checked in Electron (test/render/).
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { eyePose } from '../../../src/motion/core.ts'
import type { PoseRecord } from '../../../src/motion/core.ts'
import { createRenderHost, DEFAULT_EYE_HEIGHT, DEFAULT_STIMULUS_SETTINGS } from '../../../src/render/index.ts'
import type { FrameScheduler, HostPose, RenderContent, RenderHostOptions } from '../../../src/render/index.ts'
import { fakeRendererClass } from './fakeRenderer.ts'

const canvas = () => ({ width: 300, height: 150 }) as unknown as OffscreenCanvas

function host(options: Partial<RenderHostOptions> = {}, renderer: Parameters<typeof fakeRendererClass>[0] = {}) {
  const { FakeWebGLRenderer, instances } = fakeRendererClass(renderer)
  const h = createRenderHost({ canvas: canvas(), width: 800, height: 600, pixelRatio: 1, WebGLRenderer: FakeWebGLRenderer, ...options })
  return { host: h, fake: instances[0]! }
}

function content(scene = new THREE.Scene(), projection = { fov: 75, near: 0.1, far: 1000 }): RenderContent {
  return { scene, projection, start: { x: 0, feetY: 0, z: 0, yaw: 0 }, assets: [], diagnostics: [], source: 'test' }
}

const pose = (overrides: Partial<HostPose> = {}): HostPose =>
  ({ seq: 1, epoch: 0, t_dev_us: 50_000, x: 0, feetY: 0, z: 0, yaw: 0, ...overrides })

describe('stimulus renderer (D7 a)', () => {
  it('creates the renderer with every context attribute written out and the high-performance GPU', () => {
    const { fake } = host()
    expect(fake.callsOf('construct')).toHaveLength(1)
    const { canvas: _canvas, ...parameters } = fake.parameters
    expect(parameters).toEqual({
      alpha: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false, antialias: true, powerPreference: 'high-performance'
    })
  })

  it('sets no tone mapping, sRGB output, black clear colour and no shadows as properties', () => {
    const { host: h, fake } = host()
    expect(fake.writes).toEqual([
      ['toneMapping', THREE.NoToneMapping],
      ['toneMappingExposure', 1],
      ['outputColorSpace', THREE.SRGBColorSpace],
      ['shadowMap.enabled', false],
      ['shadowMap.type', THREE.PCFShadowMap]
    ])
    expect(fake.callsOf('setClearColor')).toEqual([['setClearColor', 0x000000, 1]])
    expect(h.info().settings).toMatchObject({
      shadows: false, shadowMapType: 'PCFShadowMap', pointLightShadows: false, toneMapping: 'NoToneMapping',
      toneMappingExposure: 1, outputColorSpace: 'srgb', colorManagement: true, colorTextures: 'srgb', anisotropy: 1,
      pixelRatio: 1, clearColor: 0, clearAlpha: 1, requestedAntialias: true, requestedPowerPreference: 'high-performance',
      'context.alpha': false, 'context.antialias': true, 'context.powerPreference': 'high-performance'
    })
  })

  it('uses the pixel ratio it is given, never the window, and never writes the canvas style', () => {
    const { host: h, fake } = host({ width: 960, height: 540, pixelRatio: 2 })
    expect(fake.calls.filter(call => call[0] === 'setPixelRatio' || call[0] === 'setSize'))
      .toEqual([['setPixelRatio', 2], ['setSize', 960, 540, false]])
    expect(h.info()).toMatchObject({ size: [960, 540], drawingBuffer: [1920, 1080], pixelRatio: 2 })
    h.resize(1280, 720, 1.5)
    h.resize(640, 360)
    expect(fake.callsOf('setSize').map(call => call[3])).toEqual([false, false, false])
    expect(h.info()).toMatchObject({ size: [640, 360], drawingBuffer: [960, 540], pixelRatio: 1.5 })
  })

  it('turns shadow maps on only when the settings ask for them', () => {
    expect(host().fake.shadowMap.enabled).toBe(false)
    expect(host({ settings: { shadows: true } }).fake.shadowMap.enabled).toBe(true)
    expect(DEFAULT_STIMULUS_SETTINGS).toEqual({ shadows: false, anisotropy: 1, antialias: true, powerPreference: 'high-performance' })
  })

  it('rejects settings, sizes and eye heights it cannot use', () => {
    expect(() => host({ settings: { anisotropy: 0 } })).toThrow(/anisotropy/)
    expect(() => host({ settings: { powerPreference: 'fast' as 'default' } })).toThrow(/powerPreference/)
    expect(() => host({ width: 0 })).toThrow(/width and height/)
    expect(() => host({ pixelRatio: Number.NaN })).toThrow(/pixelRatio/)
    expect(() => host({ eyeHeight: 0 })).toThrow(/eyeHeight/)
    expect(() => host().host.setContent(content(new THREE.Scene(), { fov: 0, near: 0.1, far: 1000 }))).toThrow(/fov/)
    expect(() => host().host.setContent(content(new THREE.Scene(), { fov: 75, near: 10, far: 1 }))).toThrow(/near/)
  })
})

describe('stimulus policy (D7 a)', () => {
  function policyScene() {
    const scene = new THREE.Scene()
    const map = new THREE.Texture()
    const emissiveMap = new THREE.Texture()
    const normalMap = new THREE.Texture()
    const material = new THREE.MeshStandardMaterial({ map, emissiveMap, normalMap })
    const shared = new THREE.MeshBasicMaterial({ map })
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material), new THREE.Mesh(new THREE.BoxGeometry(), shared))
    const point = new THREE.PointLight(0xffffff, 1, 50, 2)
    point.castShadow = true
    const directional = new THREE.DirectionalLight(0xffffff, 1)
    directional.castShadow = true
    scene.add(point, directional)
    return { scene, map, emissiveMap, normalMap, point, directional }
  }

  it('makes colour textures sRGB with the anisotropy asked for, capped at the GPU maximum', () => {
    for (const [asked, max, expected] of [[1, 16, 1], [8, 16, 8], [16, 4, 4]]) {
      const s = policyScene()
      const { host: h } = host({ settings: { anisotropy: asked } }, { maxAnisotropy: max })
      const result = h.setContent(content(s.scene))
      expect(result.colorMaps).toBe(2)
      for (const texture of [s.map, s.emissiveMap]) {
        expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
        expect(texture.anisotropy).toBe(expected)
        expect(texture.version).toBeGreaterThan(0) // needsUpdate
      }
      // Data textures stay linear and unfiltered
      expect(s.normalMap.colorSpace).toBe(THREE.NoColorSpace)
      expect(s.normalMap.anisotropy).toBe(1)
      expect(h.info().settings.anisotropy).toBe(expected)
    }
  })

  it('switches off point-light shadows and leaves other lights as the content has them', () => {
    const s = policyScene()
    const { host: h } = host({ settings: { shadows: true } })
    expect(h.setContent(content(s.scene))).toEqual({ colorMaps: 2, pointLightShadowsOff: 1 })
    expect(s.point.castShadow).toBe(false)
    expect(s.directional.castShadow).toBe(true)
  })
})

describe('camera', () => {
  const records: PoseRecord[] = [
    { seq: 1, epoch: 0, t_dev_us: 50_000, x: 0, feetY: 0, z: 0, yaw: 0, contact: false, airborne: false },
    { seq: 2, epoch: 0, t_dev_us: 100_000, x: 1.25, feetY: 0, z: -30, yaw: 0.7, contact: false, airborne: false },
    { seq: 3, epoch: 1, t_dev_us: 150_000, x: -19, feetY: 7.25, z: 69.9, yaw: -2.5, contact: true, airborne: false },
    { seq: 4, epoch: 1, t_dev_us: 200_000, x: 3, feetY: -4, z: 1, yaw: 40, contact: false, airborne: true }
  ]

  it('stands at the pose feet plus the eye height, turned by the yaw, with no other offset (eyePose)', () => {
    for (const eyeHeight of [DEFAULT_EYE_HEIGHT, 2.5]) {
      const { host: h } = host({ eyeHeight })
      h.setContent(content())
      for (const record of records) {
        h.setPose(record)
        h.renderFrame()
        const eye = eyePose(record, eyeHeight)
        const position = h.camera.getWorldPosition(new THREE.Vector3())
        expect(position.x).toBe(eye.x)
        expect(position.y).toBeCloseTo(eye.y, 12)
        expect(position.z).toBe(eye.z)
        // yaw 0 looks down -Z, positive yaw turns counter-clockwise seen from above (ADR-0001 R1)
        const direction = h.camera.getWorldDirection(new THREE.Vector3())
        expect(direction.x).toBeCloseTo(-Math.sin(eye.yaw), 12)
        expect(direction.y).toBeCloseTo(0, 12)
        expect(direction.z).toBeCloseTo(-Math.cos(eye.yaw), 12)
        expect(h.camera.parent).toBeNull()
      }
    }
    expect(DEFAULT_EYE_HEIGHT).toBe(3.7)
  })

  it("takes the content's projection and the drawing area's aspect, also after a resize", () => {
    const { host: h } = host({ width: 1920, height: 1080 })
    h.setContent(content(new THREE.Scene(), { fov: 60, near: 0.5, far: 500 }))
    expect([h.camera.fov, h.camera.near, h.camera.far, h.camera.aspect]).toEqual([60, 0.5, 500, 1920 / 1080])
    const before = h.camera.projectionMatrix.clone()
    h.handleMessage({ type: 'resize', width: 5760, height: 1080, pixelRatio: 1 })
    expect(h.camera.aspect).toBe(5760 / 1080)
    expect(h.camera.projectionMatrix.equals(before)).toBe(false)
    const expected = new THREE.PerspectiveCamera(60, 5760 / 1080, 0.5, 500)
    expect(h.camera.projectionMatrix.elements).toEqual(expected.projectionMatrix.elements)
  })
})

describe('frames', () => {
  it('draws black until it has content and a pose, then the scene; blanking draws black again', () => {
    const { host: h, fake } = host()
    const scene = new THREE.Scene()
    const outcomes: string[] = []
    const draw = () => {
      const before = fake.calls.length
      const frame = h.renderFrame()
      outcomes.push(frame.outcome)
      return fake.calls.slice(before)
    }
    expect(draw()).toEqual([['setClearColor', 0, 1], ['clear', true, true, true]])
    h.setContent(content(scene))
    expect(draw()).toEqual([['setClearColor', 0, 1], ['clear', true, true, true]])
    h.setPose(pose())
    expect(draw()).toEqual([['render', scene, h.camera]])
    h.setRenderState({ seq: 1, epoch: 0, display: 'blank' })
    expect(draw()).toEqual([['setClearColor', 0, 1], ['clear', true, true, true]])
    h.setRenderState({ seq: 2, epoch: 0, display: 'on' })
    expect(draw()).toEqual([['render', scene, h.camera]])
    expect(outcomes).toEqual(['no_content', 'no_pose', 'scene', 'blank', 'scene'])
  })

  it('numbers its frames and stamps each with the pose drawn and the blank and freeze flags', () => {
    const { host: h } = host()
    h.setContent(content())
    const frames = []
    frames.push({ ...h.renderFrame(16.7) })
    h.setPose(pose({ seq: 7, epoch: 2, t_dev_us: 350_000 }))
    frames.push({ ...h.renderFrame(33.4) })
    h.setRenderState({ freeze: true })
    frames.push({ ...h.renderFrame() })
    h.setRenderState({ display: 'blank' })
    frames.push({ ...h.renderFrame() })
    expect(frames.map(({ frame, tRafMs, outcome, seq, epoch, tDevUs, blank, frozen }) =>
      ({ frame, tRafMs, outcome, seq, epoch, tDevUs, blank, frozen }))).toEqual([
      { frame: 0, tRafMs: 16.7, outcome: 'no_pose', seq: null, epoch: null, tDevUs: null, blank: false, frozen: false },
      { frame: 1, tRafMs: 33.4, outcome: 'scene', seq: 7, epoch: 2, tDevUs: 350_000, blank: false, frozen: false },
      { frame: 2, tRafMs: null, outcome: 'scene', seq: 7, epoch: 2, tDevUs: 350_000, blank: false, frozen: true },
      { frame: 3, tRafMs: null, outcome: 'blank', seq: null, epoch: null, tDevUs: null, blank: true, frozen: true }
    ])
    for (const frame of frames) expect(frame.tEndMs).toBeGreaterThanOrEqual(frame.tStartMs)
    expect(h.info().frames).toBe(4)
  })

  it('draws the newest pose it was given', () => {
    const { host: h } = host()
    h.setContent(content())
    h.setPose(pose({ seq: 1, z: -1 }))
    h.setPose(pose({ seq: 2, z: -2 }))
    expect(h.renderFrame().seq).toBe(2)
    expect(h.camera.position.z).toBe(-2)
  })
})

describe('inputs', () => {
  it('takes poses, render-state changes and sizes as messages', () => {
    const { host: h } = host()
    h.setContent(content())
    h.handleMessage({ type: 'pose', pose: pose({ seq: 9, x: 4 }) })
    h.handleMessage({ type: 'render_state', change: { seq: 9, epoch: 0, freeze: true } })
    h.handleMessage({ type: 'resize', width: 400, height: 200, pixelRatio: 2 })
    const frame = h.renderFrame()
    expect([frame.seq, frame.frozen, h.camera.position.x]).toEqual([9, true, 4])
    expect(h.info().drawingBuffer).toEqual([800, 400])
    expect(() => h.handleMessage({ type: 'teleport' } as never)).toThrow(/unknown message type "teleport"/)
    expect(() => h.handleMessage(null as never)).toThrow(/unknown message type/)
  })

  it('rejects poses and render-state changes that would draw a wrong frame', () => {
    const { host: h } = host()
    expect(() => h.setPose(pose({ x: Number.NaN }))).toThrow(/pose x/)
    expect(() => h.setPose(pose({ yaw: Number.POSITIVE_INFINITY }))).toThrow(/pose yaw/)
    expect(() => h.setPose(pose({ seq: -1 }))).toThrow(/pose seq/)
    expect(() => h.setPose(pose({ epoch: 0.5 }))).toThrow(/pose epoch/)
    // Every frame drawn from the pose carries its device time
    expect(() => h.setPose(pose({ t_dev_us: 1.5 }))).toThrow(/pose t_dev_us/)
    expect(() => h.setPose({ ...pose(), t_dev_us: undefined } as unknown as HostPose)).toThrow(/pose t_dev_us/)
    expect(() => h.setRenderState({ display: 'grey' as 'on' })).toThrow(/display/)
    expect(() => h.setRenderState({ freeze: 1 as unknown as boolean })).toThrow(/freeze/)
  })

  it('keeps a copy of the pose it checked, whatever the caller does with its object later', () => {
    const { host: h } = host()
    h.setContent(content())
    const reused = pose({ seq: 3, t_dev_us: 150_000, x: 2, z: -5 })
    h.setPose(reused)
    Object.assign(reused, { seq: 4, t_dev_us: Number.NaN, x: Number.NaN, z: Number.POSITIVE_INFINITY })
    const frame = h.renderFrame()
    expect([frame.outcome, frame.seq, frame.tDevUs]).toEqual(['scene', 3, 150_000])
    expect([h.camera.position.x, h.camera.position.z]).toEqual([2, -5])
  })
})

describe('frame loop', () => {
  function scheduler() {
    const queue = new Map<number, (time: number) => void>()
    let next = 1
    const cancelled: number[] = []
    const s: FrameScheduler = {
      request(callback) { queue.set(next, callback); return next++ },
      cancel(handle) { cancelled.push(handle); queue.delete(handle) }
    }
    const tick = (time: number) => {
      const callbacks = [...queue.values()]
      queue.clear()
      for (const callback of callbacks) callback(time)
    }
    return { s, tick, queue, cancelled }
  }

  it('draws one frame per callback of the scheduler it is given, until stopped', () => {
    const { host: h } = host()
    h.setContent(content())
    h.setPose(pose())
    const { s, tick, queue, cancelled } = scheduler()
    h.start(s)
    expect(h.running).toBe(true)
    expect(() => h.start(s)).toThrow(/already running/)
    for (const time of [16, 33, 50]) tick(time)
    expect(h.info().frames).toBe(3)
    expect(queue.size).toBe(1)
    h.stop()
    expect(h.running).toBe(false)
    expect(cancelled).toHaveLength(1)
    expect(queue.size).toBe(0)
    tick(66)
    expect(h.info().frames).toBe(3)
  })

  it('stops when a frame throws, and reports the error', () => {
    const { host: h, fake } = host()
    h.setContent(content())
    h.setPose(pose())
    fake.render = () => { throw new Error('context lost') }
    const { s, tick, queue } = scheduler()
    h.start(s)
    expect(() => tick(16)).toThrow('context lost')
    expect(h.running).toBe(false)
    expect(queue.size).toBe(0)
  })
})

describe('dispose', () => {
  it('frees the content and the renderer, and refuses to be used again', () => {
    const { host: h, fake } = host()
    const geometry = new THREE.BoxGeometry()
    const material = new THREE.MeshBasicMaterial({ map: new THREE.Texture() })
    const scene = new THREE.Scene()
    scene.add(new THREE.Mesh(geometry, material))
    const disposed: string[] = []
    geometry.addEventListener('dispose', () => disposed.push('geometry'))
    material.addEventListener('dispose', () => disposed.push('material'))
    material.map!.addEventListener('dispose', () => disposed.push('texture'))
    h.setContent(content(scene))
    h.dispose()
    expect(disposed.sort()).toEqual(['geometry', 'material', 'texture'])
    expect(fake.callsOf('dispose')).toHaveLength(1)
    expect(() => h.renderFrame()).toThrow(/after dispose/)
    h.dispose() // a second dispose does nothing
    expect(fake.callsOf('dispose')).toHaveLength(1)
  })

  it('frees earlier content when it is given new content', () => {
    const { host: h } = host()
    const first = new THREE.Scene()
    const geometry = new THREE.BoxGeometry()
    first.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()))
    let freed = false
    geometry.addEventListener('dispose', () => { freed = true })
    h.setContent(content(first))
    h.setContent(content(first))
    expect(freed).toBe(false)
    h.setContent(content(new THREE.Scene()))
    expect(freed).toBe(true)
  })
})
