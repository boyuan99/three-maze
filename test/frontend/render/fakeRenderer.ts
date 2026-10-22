// A WebGLRenderer stand-in for the render host's tests: Node has no WebGL. It keeps the state the
// host sets (with three's semantics for size, pixel ratio and clear colour) and records what the
// host asks of it, in order. What a GPU would draw is not modelled; test/render/ (Electron) is.
import * as THREE from 'three'

export type FakeCall =
  | ['construct', Record<string, unknown>]
  | ['setPixelRatio', number]
  | ['setSize', number, number, boolean | undefined]
  | ['setClearColor', number, number]
  | ['clear', boolean, boolean, boolean]
  | ['render', THREE.Object3D, THREE.Camera]
  | ['dispose']

export interface FakeRendererOptions {
  /** What capabilities.getMaxAnisotropy() reports */
  maxAnisotropy?: number
  /** What the context reports from getContextAttributes() */
  contextAttributes?: Record<string, unknown>
}

/** A renderer class for RenderHostOptions.WebGLRenderer; its instances are listed in `instances` */
export function fakeRendererClass(options: FakeRendererOptions = {}) {
  const instances: FakeRenderer[] = []
  class Bound extends FakeRenderer {
    constructor(parameters: THREE.WebGLRendererParameters) {
      super(parameters, options)
      instances.push(this)
    }
  }
  return { FakeWebGLRenderer: Bound as unknown as new (parameters: THREE.WebGLRendererParameters) => THREE.WebGLRenderer, instances }
}

export class FakeRenderer {
  readonly calls: FakeCall[] = []
  readonly parameters: Record<string, unknown>
  readonly canvas: { width: number, height: number }
  /** Properties written by the host, in order: [name, value] */
  readonly writes: Array<[string, unknown]> = []
  readonly shadowMap: { enabled: boolean, type: THREE.ShadowMapType }
  readonly capabilities: { getMaxAnisotropy(): number }
  readonly info = { programs: [] as unknown[], memory: { textures: 0, geometries: 0 }, render: { calls: 0, triangles: 0 } }
  private width: number
  private height: number
  private pixelRatio = 1
  private clearColor = new THREE.Color(0x000000)
  private clearAlpha = 1
  private toneMappingValue: THREE.ToneMapping = THREE.NoToneMapping
  private exposureValue = 1
  private outputColorSpaceValue: string = THREE.SRGBColorSpace
  private readonly contextAttributes: Record<string, unknown>

  constructor(parameters: THREE.WebGLRendererParameters, options: FakeRendererOptions) {
    this.parameters = { ...parameters }
    this.calls.push(['construct', this.parameters])
    this.canvas = (parameters.canvas as unknown as { width: number, height: number }) ?? { width: 300, height: 150 }
    this.width = this.canvas.width
    this.height = this.canvas.height
    const writes = this.writes
    const shadowMap = { enabled: false, type: THREE.PCFShadowMap as THREE.ShadowMapType }
    this.shadowMap = new Proxy(shadowMap, {
      set(target, key, value) {
        writes.push([`shadowMap.${String(key)}`, value])
        return Reflect.set(target, key, value)
      }
    })
    const maxAnisotropy = options.maxAnisotropy ?? 16
    this.capabilities = { getMaxAnisotropy: () => maxAnisotropy }
    this.contextAttributes = {
      alpha: parameters.alpha, antialias: parameters.antialias, depth: parameters.depth, stencil: parameters.stencil,
      premultipliedAlpha: parameters.premultipliedAlpha, preserveDrawingBuffer: parameters.preserveDrawingBuffer,
      failIfMajorPerformanceCaveat: parameters.failIfMajorPerformanceCaveat, powerPreference: parameters.powerPreference,
      desynchronized: false, ...options.contextAttributes
    }
  }

  get toneMapping() { return this.toneMappingValue }
  set toneMapping(value: THREE.ToneMapping) { this.writes.push(['toneMapping', value]); this.toneMappingValue = value }
  get toneMappingExposure() { return this.exposureValue }
  set toneMappingExposure(value: number) { this.writes.push(['toneMappingExposure', value]); this.exposureValue = value }
  get outputColorSpace() { return this.outputColorSpaceValue }
  set outputColorSpace(value: string) { this.writes.push(['outputColorSpace', value]); this.outputColorSpaceValue = value }

  setPixelRatio(value: number) {
    this.calls.push(['setPixelRatio', value])
    this.pixelRatio = value
    this.resizeCanvas()
  }

  getPixelRatio() { return this.pixelRatio }

  setSize(width: number, height: number, updateStyle?: boolean) {
    this.calls.push(['setSize', width, height, updateStyle])
    this.width = width
    this.height = height
    this.resizeCanvas()
  }

  getDrawingBufferSize(target: THREE.Vector2) {
    return target.set(this.width * this.pixelRatio, this.height * this.pixelRatio).floor()
  }

  setClearColor(color: THREE.ColorRepresentation, alpha = 1) {
    this.clearColor.set(color)
    this.clearAlpha = alpha
    this.calls.push(['setClearColor', this.clearColor.getHex(), alpha])
  }

  getClearColor(target: THREE.Color) { return target.copy(this.clearColor) }
  getClearAlpha() { return this.clearAlpha }

  clear(color = true, depth = true, stencil = true) {
    this.calls.push(['clear', color, depth, stencil])
  }

  render(scene: THREE.Object3D, camera: THREE.Camera) {
    // Like three: world matrices are brought up to date before drawing
    scene.updateMatrixWorld()
    if (camera.parent === null) camera.updateMatrixWorld()
    this.calls.push(['render', scene, camera])
    this.info.render.calls = 1
  }

  getContext() {
    return { getContextAttributes: () => ({ ...this.contextAttributes }) }
  }

  dispose() {
    this.calls.push(['dispose'])
  }

  /** The calls of one kind */
  callsOf<K extends FakeCall[0]>(kind: K) {
    return this.calls.filter((call): call is Extract<FakeCall, [K, ...unknown[]]> => call[0] === kind)
  }

  private resizeCanvas() {
    this.canvas.width = Math.floor(this.width * this.pixelRatio)
    this.canvas.height = Math.floor(this.height * this.pixelRatio)
  }
}
