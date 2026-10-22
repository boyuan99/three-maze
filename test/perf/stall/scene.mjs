// The stall suite's scene, shared by the main-thread loop (bench.mjs) and the worker loop
// (render-worker.mjs), so that both draw the same frames. It is the scene of ADR-0003 Evidence 1
// (proto/rendering/bench.mjs, variant `unlit`, and render-worker.mjs in three-maze-notes): an unlit
// replica of HallwaySerialMigrated (its boxes with MeshBasicMaterial, the chess texture in sRGB with
// the GPU's maximum anisotropy, no lights, no shadows), drawn into a 1920 x 1080 buffer at pixel
// ratio 1 while the camera walks the corridor at eye height 3.7.
//
// Plain JavaScript with three imported by URL (main.cjs serves node_modules/three/build at /three/),
// because a module worker does not use the page's import map.
import * as THREE from '/three/three.module.js'

export const WIDTH = 1920
export const HEIGHT = 1080
const MAZE = '/maze/'

/** The renderer, scene and camera on a canvas (an HTMLCanvasElement or a transferred OffscreenCanvas) */
export async function buildScene (canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(1)
  renderer.setSize(WIDTH, HEIGHT, false)
  const config = await (await fetch(`${MAZE}HallwaySerialMigrated.json`)).json()
  // ImageBitmapLoader in both loops (the prototype's main thread used TextureLoader): the same
  // decoded image either way, and the only loader a worker has (ADR-0003 1c)
  const loader = new THREE.ImageBitmapLoader()
  loader.setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none' })
  const bitmap = await loader.loadAsync(`${MAZE}assets/Chess_Pattern.jpg`)
  const base = new THREE.Texture(bitmap)
  base.flipY = false
  base.colorSpace = THREE.SRGBColorSpace
  const scene = new THREE.Scene()
  for (const object of config.objects) {
    const g = object.geometry
    if (g.type !== 'box') continue
    const material = new THREE.MeshBasicMaterial({ color: object.material?.color || 0xffffff })
    if (object.material?.map) {
      const texture = base.clone()
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      if (object.material.repeat) texture.repeat.set(object.material.repeat.x, object.material.repeat.y)
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
      texture.needsUpdate = true
      material.map = texture
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(g.width || 1, g.height || 1, g.depth || 1), material)
    mesh.position.set(object.position?.x || 0, object.position?.y || 0, object.position?.z || 0)
    mesh.rotation.set(object.rotation?.x || 0, object.rotation?.y || 0, object.rotation?.z || 0)
    scene.add(mesh)
  }
  const camera = new THREE.PerspectiveCamera(75, WIDTH / HEIGHT, 0.1, 1000)
  return { renderer, scene, camera }
}

/** Frame i of the walk: 0.5 units a frame down the corridor, 240-frame cycle, yaw swinging 0.6 rad */
export function poseCamera (camera, i) {
  camera.position.set(0, 3.7, 60 - (i % 240) * 0.5)
  camera.rotation.set(0, 0.6 * Math.sin((i * 2 * Math.PI) / 240), 0)
}

/** What the WebGL context is (for the result file) */
export function describeGl (renderer) {
  const gl = renderer.getContext()
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
    vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    version: String(gl.getParameter(gl.VERSION)),
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    contextAttributes: gl.getContextAttributes(),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs?.length ?? null
  }
}

/**
 * Draws warm + frames frames on the given requestAnimationFrame and records, per frame, the rAF
 * timestamp and performance.now() at the callback's entry and exit (ms, this realm's clock).
 */
export function runFrames ({ renderer, scene, camera }, requestFrame, { frames, warm }) {
  const n = warm + frames
  const raf = new Float64Array(n)
  const entry = new Float64Array(n)
  const exit = new Float64Array(n)
  return new Promise(resolve => {
    let i = 0
    const frame = (timestamp) => {
      entry[i] = performance.now()
      raf[i] = timestamp
      poseCamera(camera, i)
      renderer.render(scene, camera)
      exit[i] = performance.now()
      i++
      if (i < n) requestFrame(frame)
      else resolve({ raf, entry, exit })
    }
    requestFrame(frame)
  })
}
