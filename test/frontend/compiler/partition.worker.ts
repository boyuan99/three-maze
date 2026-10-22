// Web Worker entry for the Worker-bundle and Electron tests of the partitioner (partition.test.ts).
// Vite bundles it as it will bundle the code that compiles scenes off the main thread; the test
// runs the bundle in a worker thread, in Node and in Electron's Node, and posts it the mazes.
import { answer } from './partitionChecks.ts'
import type { ManifestJob } from './partitionChecks.ts'

self.onmessage = (event: MessageEvent<ManifestJob>) => {
  try {
    self.postMessage({ ok: true, result: answer(event.data) })
  } catch (error) {
    const text = error instanceof Error ? error.stack ?? error.message : String(error)
    self.postMessage({ ok: false, error: text })
  }
}
