// The stimulus renderer: a WebGLRenderer on the canvas the render host is given, with every setting
// written out (owner decision D7 a, 2026-10-09: shadows off unless asked for, no point-light
// shadows, no tone mapping, sRGB colour textures, an explicit pixel ratio, the high-performance GPU),
// and the stimulus policy the host applies to the scene graph it is given.
//
// v0.3's settings, for comparison (src/scenes/serial/PythonCustomScene.vue:576-585, quirks in
// src/compat/v0/README.md): antialias; ACES tone mapping passed to the constructor, which r169 does
// not read, so no tone mapping took effect; no setPixelRatio, so a pixel ratio of 1; shadow maps
// always on, cube shadows from every point light with castShadow; colour textures in NoColorSpace.
import * as THREE from 'three'

/** An HTMLCanvasElement (scene window) or an OffscreenCanvas (worker): what WebGLRenderer accepts */
export type HostCanvas = NonNullable<THREE.WebGLRendererParameters['canvas']>

/** The settings a session may choose (REN-3 settles their values and the scene schema's block). */
export interface StimulusSettings {
  /**
   * Shadow maps (PCF). Off by default (D7 a). Point lights never cast shadows, whatever the scene
   * asks: one cube shadow pass per light costs six renders a frame.
   */
  shadows: boolean
  /** Anisotropic filtering of colour textures; 1 is none, three's default and v0.3's value. */
  anisotropy: number
  /** Multisampled antialiasing of the canvas, as v0.3 asks. */
  antialias: boolean
  /** The GPU the context asks for (D7 a: high-performance, the discrete GPU of a hybrid machine). */
  powerPreference: 'high-performance' | 'low-power' | 'default'
}

export const DEFAULT_STIMULUS_SETTINGS: Readonly<StimulusSettings> = Object.freeze({
  shadows: false,
  anisotropy: 1,
  antialias: true,
  powerPreference: 'high-performance'
})

/** The colour shown before the first pose, while the display is blanked, and where nothing is drawn (D14 a). */
export const BLANK_COLOR = 0x000000

/**
 * The context attributes besides antialias and powerPreference: three's defaults, written out.
 * three r169 creates every context with alpha (WebGLRenderer.js:228-237); alpha false makes it clear
 * to an opaque colour (clear alpha 1), so the canvas shows no page behind it.
 */
export const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: false
})

export interface StimulusRendererOptions {
  canvas: HostCanvas
  /** Drawing area in CSS pixels; the drawing buffer is this size times pixelRatio. */
  width: number
  height: number
  /** Device pixels per CSS pixel, given explicitly: the host never reads the window's ratio. */
  pixelRatio: number
  settings: StimulusSettings
  /** The renderer class; tests pass a stand-in, since Node has no WebGL. */
  WebGLRenderer?: new (parameters: THREE.WebGLRendererParameters) => THREE.WebGLRenderer
}

export function checkStimulusSettings(settings: StimulusSettings): StimulusSettings {
  const fail = (what: string) => {
    throw new TypeError(`stimulus settings: ${what}`)
  }
  if (typeof settings.shadows !== 'boolean') fail('shadows must be true or false')
  if (typeof settings.antialias !== 'boolean') fail('antialias must be true or false')
  if (!Number.isInteger(settings.anisotropy) || settings.anisotropy < 1) fail('anisotropy must be an integer >= 1')
  if (!['high-performance', 'low-power', 'default'].includes(settings.powerPreference)) {
    fail("powerPreference must be 'high-performance', 'low-power' or 'default'")
  }
  return settings
}

export function checkSize(width: number, height: number, pixelRatio: number): void {
  if (!(Number.isFinite(width) && width >= 1 && Number.isFinite(height) && height >= 1)) {
    throw new TypeError(`render host: width and height must be at least 1 (got ${width} x ${height})`)
  }
  if (!(Number.isFinite(pixelRatio) && pixelRatio > 0)) {
    throw new TypeError(`render host: pixelRatio must be a number > 0 (got ${pixelRatio})`)
  }
}

/**
 * A WebGLRenderer with the stimulus settings. setSize never writes the canvas's style: sizing the
 * element on the page is the scene window's job, and an OffscreenCanvas has no style.
 */
export function createStimulusRenderer(options: StimulusRendererOptions): THREE.WebGLRenderer {
  const { canvas, width, height, pixelRatio, WebGLRenderer = THREE.WebGLRenderer } = options
  const settings = checkStimulusSettings({ ...options.settings })
  checkSize(width, height, pixelRatio)
  const renderer = new WebGLRenderer({
    canvas,
    ...CONTEXT_ATTRIBUTES,
    antialias: settings.antialias,
    powerPreference: settings.powerPreference
  })
  renderer.setPixelRatio(pixelRatio)
  renderer.setSize(width, height, false)
  // Set as properties: r169's constructor ignores tone-mapping parameters (v0 quirk 8)
  renderer.toneMapping = THREE.NoToneMapping
  renderer.toneMappingExposure = 1
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = settings.shadows
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(BLANK_COLOR, 1)
  return renderer
}

export interface StimulusPolicyResult {
  /** Textures marked as colour textures: sRGB, with the session's anisotropy */
  colorMaps: number
  /** Point lights whose shadow casting was switched off */
  pointLightShadowsOff: number
}

// Material slots that hold colours rather than data (normals, roughness, ...), as three reads them
const COLOR_MAP_SLOTS = ['map', 'emissiveMap', 'specularColorMap', 'sheenColorMap'] as const

/**
 * Applies the stimulus policy (D7 a) to a scene graph before its first frame: colour textures are
 * sRGB with the session's anisotropy (capped at the GPU's maximum), and point lights cast no
 * shadows. Data textures are left as they are.
 */
export function applyStimulusPolicy(scene: THREE.Object3D, settings: StimulusSettings, maxAnisotropy: number): StimulusPolicyResult {
  const anisotropy = Math.max(1, Math.min(settings.anisotropy, maxAnisotropy))
  const colorMaps = new Set<THREE.Texture>()
  let pointLightShadowsOff = 0
  scene.traverse(object => {
    if ((object as THREE.PointLight).isPointLight && object.castShadow) {
      object.castShadow = false
      pointLightShadowsOff++
    }
    const material = (object as THREE.Mesh).material
    if (!material) return
    for (const m of Array.isArray(material) ? material : [material]) {
      const slots = m as unknown as Record<string, unknown>
      for (const slot of COLOR_MAP_SLOTS) {
        const texture = slots[slot]
        if ((texture as THREE.Texture | undefined)?.isTexture) colorMaps.add(texture as THREE.Texture)
      }
    }
  })
  for (const texture of colorMaps) {
    if (texture.colorSpace !== THREE.SRGBColorSpace || texture.anisotropy !== anisotropy) {
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = anisotropy
      texture.needsUpdate = true
    }
  }
  return { colorMaps: colorMaps.size, pointLightShadowsOff }
}

export type RenderSettingValue = boolean | number | string

const TONE_MAPPING_NAMES: Record<number, string> = {
  [THREE.NoToneMapping]: 'NoToneMapping',
  [THREE.LinearToneMapping]: 'LinearToneMapping',
  [THREE.ReinhardToneMapping]: 'ReinhardToneMapping',
  [THREE.CineonToneMapping]: 'CineonToneMapping',
  [THREE.ACESFilmicToneMapping]: 'ACESFilmicToneMapping',
  [THREE.AgXToneMapping]: 'AgXToneMapping',
  [THREE.NeutralToneMapping]: 'NeutralToneMapping',
  [THREE.CustomToneMapping]: 'CustomToneMapping'
}

const SHADOW_MAP_NAMES: Record<number, string> = {
  [THREE.BasicShadowMap]: 'BasicShadowMap',
  [THREE.PCFShadowMap]: 'PCFShadowMap',
  [THREE.PCFSoftShadowMap]: 'PCFSoftShadowMap',
  [THREE.VSMShadowMap]: 'VSMShadowMap'
}

/**
 * The effective renderer settings by name, read back from the renderer and its WebGL context (what
 * the browser granted, which can differ from what was asked), in the form of the render report's
 * `settings` (protocol/v1/render.report.schema.json): names and values are booleans, numbers or
 * identifiers. For the ready report and session provenance (REN-3, REN-8).
 */
export function describeRenderer(renderer: THREE.WebGLRenderer, settings: StimulusSettings): Record<string, RenderSettingValue> {
  const described: Record<string, RenderSettingValue> = {
    shadows: renderer.shadowMap.enabled,
    shadowMapType: SHADOW_MAP_NAMES[renderer.shadowMap.type] ?? String(renderer.shadowMap.type),
    pointLightShadows: false,
    toneMapping: TONE_MAPPING_NAMES[renderer.toneMapping] ?? String(renderer.toneMapping),
    toneMappingExposure: renderer.toneMappingExposure,
    outputColorSpace: renderer.outputColorSpace,
    colorManagement: THREE.ColorManagement.enabled,
    colorTextures: THREE.SRGBColorSpace,
    anisotropy: Math.max(1, Math.min(settings.anisotropy, renderer.capabilities.getMaxAnisotropy())),
    pixelRatio: renderer.getPixelRatio(),
    clearColor: renderer.getClearColor(new THREE.Color()).getHex(),
    clearAlpha: renderer.getClearAlpha(),
    requestedAntialias: settings.antialias,
    requestedPowerPreference: settings.powerPreference
  }
  const attributes = renderer.getContext().getContextAttributes()
  if (attributes) {
    for (const key of ['alpha', 'antialias', 'depth', 'stencil', 'premultipliedAlpha', 'preserveDrawingBuffer',
      'failIfMajorPerformanceCaveat', 'desynchronized', 'powerPreference'] as const) {
      const value = attributes[key]
      if (typeof value === 'boolean' || typeof value === 'string') described[`context.${key}`] = value
    }
  }
  return described
}
