// Runs a motion module the way the renderer's motion worker will: Vite's production build of a
// worker entry (an ES module, minified, with every import inlined, Rapier's ES build included)
// inside a Node worker thread, with a host that gives it a Web Worker's self.onmessage and
// postMessage. The entry answers one message with { ok: true, result } or { ok: false, error }.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build } from 'vite'

export interface WorkerBundle {
  /** The bundle's source text. */
  code(): string
  /** Starts the bundle in a new worker thread, posts it `message` and resolves with its result. */
  run<T>(message: unknown): Promise<T>
  /** Deletes the bundle's directory. */
  remove(): void
}

/** Builds `entry` (a URL of a worker entry module) into a temporary directory. */
export async function buildWorkerBundle(entry: URL): Promise<WorkerBundle> {
  const dir = mkdtempSync(join(tmpdir(), 'three-maze-motion-worker-'))
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir: dir,
      emptyOutDir: true,
      minify: 'esbuild',
      lib: {
        entry: fileURLToPath(entry),
        formats: ['es'],
        fileName: () => 'motion-worker.mjs',
      },
    },
  })
  writeFileSync(join(dir, 'host.mjs'), [
    "import { parentPort, workerData } from 'node:worker_threads'",
    'globalThis.self = globalThis',
    'globalThis.postMessage = (message) => parentPort.postMessage(message)',
    'await import(workerData.bundle)',
    'parentPort.on(\'message\', (data) => globalThis.onmessage({ data }))',
  ].join('\n'))
  const bundle = join(dir, 'motion-worker.mjs')
  return {
    code: () => readFileSync(bundle, 'utf8'),
    run<T>(message: unknown) {
      const worker = new Worker(join(dir, 'host.mjs'), {
        workerData: { bundle: pathToFileURL(bundle).href },
      })
      return new Promise<T>((resolve, reject) => {
        worker.once('error', reject)
        worker.once('message', (reply: { ok: boolean, result?: T, error?: string }) => {
          if (reply.ok) resolve(reply.result as T)
          else reject(new Error(reply.error))
        })
        worker.postMessage(message)
      }).finally(() => worker.terminate())
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
}
