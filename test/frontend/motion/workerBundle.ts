// Runs a motion module the way the renderer's motion worker will: Vite's production build of a
// worker entry (an ES module, minified, with every import inlined, Rapier's ES build included)
// inside a Node worker thread, with a host that gives it a Web Worker's self.onmessage and
// postMessage. The entry answers one message with { ok: true, result } or { ok: false, error }.
// runIn() does the same in another Node-compatible program, such as Electron's own Node
// (ELECTRON_RUN_AS_NODE), whose V8 is the one the renderer runs.
import { execFileSync } from 'node:child_process'
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
  /**
   * The same in a worker thread of a child process of `program` (a Node or Electron executable)
   * with the environment `env`; returns the result.
   */
  runIn<T>(program: string, env: NodeJS.ProcessEnv, message: unknown): T
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
  // runIn(): the message from a file, the reply as JSON on stdout
  writeFileSync(join(dir, 'run-once.mjs'), [
    "import { readFileSync } from 'node:fs'",
    "import { Worker } from 'node:worker_threads'",
    'const [bundle, input] = process.argv.slice(2)',
    "const worker = new Worker(new URL('./host.mjs', import.meta.url), { workerData: { bundle } })",
    "worker.once('error', (error) => { console.error(error); process.exit(1) })",
    "worker.once('message', (reply) => {",
    '  process.stdout.write(JSON.stringify(reply))',
    '  worker.terminate()',
    '})',
    "worker.postMessage(JSON.parse(readFileSync(input, 'utf8')))",
  ].join('\n'))
  const bundle = join(dir, 'motion-worker.mjs')
  const settle = <T>(reply: { ok: boolean, result?: T, error?: string }): T => {
    if (!reply.ok) throw new Error(reply.error)
    return reply.result as T
  }
  return {
    code: () => readFileSync(bundle, 'utf8'),
    run<T>(message: unknown) {
      const worker = new Worker(join(dir, 'host.mjs'), {
        workerData: { bundle: pathToFileURL(bundle).href },
      })
      return new Promise<T>((resolve, reject) => {
        worker.once('error', reject)
        worker.once('message', (reply: { ok: boolean, result?: T, error?: string }) => {
          try {
            resolve(settle(reply))
          } catch (error) {
            reject(error)
          }
        })
        worker.postMessage(message)
      }).finally(() => worker.terminate())
    },
    runIn<T>(program: string, env: NodeJS.ProcessEnv, message: unknown) {
      const input = join(dir, `message-${process.pid}-${Date.now()}.json`)
      writeFileSync(input, JSON.stringify(message))
      const args = [join(dir, 'run-once.mjs'), pathToFileURL(bundle).href, input]
      const out = execFileSync(program, args, {
        env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      })
      return settle<T>(JSON.parse(out))
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
}
