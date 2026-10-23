// The stall suite's render worker (ported from proto/rendering/render-worker.mjs in
// three-maze-notes): the same scene and loop as the main-thread condition (scene.mjs), on the
// OffscreenCanvas the page transferred, driven by the worker's own requestAnimationFrame. Its times
// are on the worker's clock (performance.timeOrigin is sent with them).
import { buildScene, describeGl, runFrames } from '/scene.mjs'

self.onmessage = async (event) => {
  if (event.data.type !== 'start') return
  try {
    const { canvas, frames, warm } = event.data
    const scene = await buildScene(canvas)
    const { raf, entry, exit } = await runFrames(scene, callback => self.requestAnimationFrame(callback), { frames, warm })
    self.postMessage({ type: 'done', raf, entry, exit, gl: describeGl(scene.renderer), timeOrigin: performance.timeOrigin },
      [raf.buffer, entry.buffer, exit.buffer])
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.stack ?? error) })
  }
}
