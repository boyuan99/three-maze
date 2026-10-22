// v0.3's renderer settings (src/scenes/serial/PythonCustomScene.vue:576-585), applied to a canvas
// the caller passes in (an HTMLCanvasElement or an OffscreenCanvas). The settings are reproduced as
// v0.3 writes them, including the two that three 0.169.0 ignores (README.md, quirk 8).
import * as THREE from 'three'

/** What v0.3 passes to the WebGLRenderer constructor, besides the canvas (:577-582) */
export const V0_RENDERER_PARAMETERS = {
  antialias: true,
  toneMapping: THREE.ACESFilmicToneMapping,   // ignored by the r169 constructor: NoToneMapping stays
  toneMappingExposure: 1.0                    // ignored too (the default is 1.0 anyway)
}

export interface V0RendererOptions {
  /** The canvas: an HTMLCanvasElement, or an OffscreenCanvas */
  canvas: NonNullable<THREE.WebGLRendererParameters['canvas']>
  /** v0.3: window.innerWidth and window.innerHeight (:583) */
  width: number
  height: number
  /**
   * Whether setSize also writes canvas.style (three's default, which v0.3 uses). Pass false for an
   * OffscreenCanvas, which has no style.
   */
  updateStyle?: boolean
  /** The renderer class; tests pass a recording stand-in, since Node has no WebGL */
  WebGLRenderer?: new (parameters: THREE.WebGLRendererParameters) => THREE.WebGLRenderer
}

/** The r169 renderer as v0.3 writes to it: physicallyCorrectLights is not one of its properties */
type V0WrittenRenderer = THREE.WebGLRenderer & { physicallyCorrectLights?: boolean }

export function createV0Renderer(options: V0RendererOptions): THREE.WebGLRenderer {
  const { canvas, width, height, updateStyle = true, WebGLRenderer = THREE.WebGLRenderer } = options
  // toneMapping and toneMappingExposure are not constructor parameters in r169 (quirk 8)
  const parameters: THREE.WebGLRendererParameters = { canvas, ...V0_RENDERER_PARAMETERS }
  const renderer: V0WrittenRenderer = new WebGLRenderer(parameters)
  renderer.setSize(width, height, updateStyle)   // no setPixelRatio: the pixel ratio stays 1
  renderer.shadowMap.enabled = true               // whatever the JSON's renderer.shadows says (:584)
  renderer.physicallyCorrectLights = true         // not a WebGLRenderer property in r169 (:585)
  return renderer
}
