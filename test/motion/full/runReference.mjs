// Runs a vendored reference script (test/motion/reference/) in a fresh Node process, the way the
// study ran it, and returns what it printed.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REFERENCE = fileURLToPath(new URL('../reference/', import.meta.url))
// Environment variables the reference scripts read. Inherited values are dropped so that only the
// settings a test passes apply (RAPIER would load another Rapier build).
const SCRIPT_VARIABLES = ['RAPIER', 'KCCDEG', 'MOVERS', 'TOP', 'EYE', 'ASPECT']

export function runReference(script, settings = {}) {
  const env = { ...process.env }
  for (const name of SCRIPT_VARIABLES) delete env[name]
  Object.assign(env, settings)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REFERENCE + script], { cwd: REFERENCE, env, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', (text) => { stdout += text })
    child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${script} exited with code ${code}:\n${stderr}`))
    })
  })
}
