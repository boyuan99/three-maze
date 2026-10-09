// Creates the Python virtual environment .venv for the backend and installs the pinned packages
// into it. Runs as the npm postinstall script; run it again with `node setup/setup-python.js`.
//
// The pins (requirements.txt) need Python 3.11 or newer (numpy 2.3); development and CI use 3.12.
// If the setup fails, it says why in a box at the end of the output and exits with code 1, so
// `npm install` fails too instead of leaving a .venv without the backend's packages.
import { fileURLToPath } from 'url'
import { basename, dirname, join } from 'path'
import { spawn } from 'child_process'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MIN_PYTHON = [3, 11]
const RECOMMENDED_PYTHON = '3.12'
const PYTHON_NEEDED = `Python ${MIN_PYTHON.join('.')} or newer (${RECOMMENDED_PYTHON} recommended)`

const venvPath = join(__dirname, '..', '.venv')
// The interpreter that creates the venv: the first one on PATH
const BASE_PYTHON = process.platform === 'win32' ? 'python' : 'python3'

// A failure the user can fix; `hint` lists what to do
class SetupError extends Error {
  constructor (message, hint = []) {
    super(message)
    this.hint = hint
  }
}

const INSTALL_PYTHON_HINT = [
  `Install ${PYTHON_NEEDED} from https://www.python.org/downloads/`,
  `and make sure that \`${BASE_PYTHON}\` on PATH runs it (check with: ${BASE_PYTHON} --version).`
]
const RERUN_HINT = 'Then run: node setup/setup-python.js'
const DELETE_VENV_HINT = 'Then delete the .venv folder and run: node setup/setup-python.js'

// The venv's own interpreter
const getVenvInterpreter = () => {
  switch (process.platform) {
    case 'win32':
      return join(venvPath, 'Scripts', 'python.exe')
    case 'darwin':
    case 'linux':
      return join(venvPath, 'bin', 'python3')
    default:
      throw new SetupError(`Unsupported platform: ${process.platform}`)
  }
}

// What to pip install: the exact pins in requirements.txt, plus the test tools in
// requirements-dev.txt (which includes requirements.txt), unless npm leaves out dev dependencies
// (npm install --omit=dev or --production, or NODE_ENV=production), as it does for devDependencies
const getRequirementsFile = () => {
  const omit = (process.env.npm_config_omit || '').split(/[\s,]+/)
  const omitDev = omit.includes('dev') ||
    process.env.npm_config_production === 'true' ||
    process.env.NODE_ENV === 'production'
  return join(__dirname, '..', omitDev ? 'requirements.txt' : 'requirements-dev.txt')
}

// Runs a command; resolves with its exit code (null if it could not be started) and its output
const run = (command, args, { echo = true } = {}) => new Promise((resolve) => {
  let output = ''
  let child
  try {
    child = spawn(command, args)
  } catch (error) {
    resolve({ code: null, output, error })
    return
  }
  child.stdout.on('data', (data) => {
    output += data
    if (echo) process.stdout.write(data)
  })
  child.stderr.on('data', (data) => {
    output += data
    if (echo) process.stderr.write(data)
  })
  child.on('error', (error) => resolve({ code: null, output, error }))
  child.on('close', (code) => resolve({ code, output }))
})

const describeFailure = (result) => {
  if (result.error) return result.error.code === 'ENOENT' ? 'not found' : result.error.message
  const output = result.output.trim().replace(/\.$/, '')
  return `exit code ${result.code}${output ? `: ${output}` : ''}`
}

// [major, minor, micro] of a Python interpreter
const getPythonVersion = async (command, label, hint) => {
  const result = await run(command, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'],
    { echo: false })
  const match = /^(\d+)\.(\d+)\.(\d+)\s*$/m.exec(result.output)
  if (result.code !== 0 || !match) {
    throw new SetupError(`Could not run ${label} (${describeFailure(result)}).`, hint)
  }
  return match.slice(1).map(Number)
}

const isSupported = ([major, minor]) =>
  major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])

const setupPython = async () => {
  const interpreter = getVenvInterpreter()

  if (!fs.existsSync(venvPath)) {
    // Check the interpreter before creating the venv: with an older Python, pip would reject the
    // pins and leave a .venv without the backend's packages
    const hint = [...INSTALL_PYTHON_HINT, RERUN_HINT]
    const version = await getPythonVersion(BASE_PYTHON, `\`${BASE_PYTHON}\``, hint)
    if (!isSupported(version)) {
      throw new SetupError(`\`${BASE_PYTHON}\` on PATH is Python ${version.join('.')}; ` +
        `three-maze needs ${PYTHON_NEEDED}.`, hint)
    }

    console.log(`Creating Python virtual environment with Python ${version.join('.')}...`)
    const created = await run(BASE_PYTHON, ['-m', 'venv', venvPath])
    if (created.code !== 0) {
      throw new SetupError(`Creating the virtual environment .venv failed (${describeFailure(created)}).`,
        ['See the messages above.', DELETE_VENV_HINT])
    }
  } else {
    // An existing .venv may come from an older Python, or from a setup that broke off
    const hint = [...INSTALL_PYTHON_HINT, DELETE_VENV_HINT]
    const version = await getPythonVersion(interpreter, `the Python of the existing .venv (${interpreter})`, hint)
    if (!isSupported(version)) {
      throw new SetupError(`The existing .venv uses Python ${version.join('.')}; ` +
        `three-maze needs ${PYTHON_NEEDED}.`, hint)
    }
  }

  // Upgrade pip first (not required: an older pip installs the pins as well)
  console.log('Upgrading pip...')
  const upgraded = await run(interpreter, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  if (upgraded.code !== 0) {
    console.warn(`Warning: upgrading pip failed (${describeFailure({ ...upgraded, output: '' })}); ` +
      'using the installed pip')
  }

  // Install requirements
  const requirements = getRequirementsFile()
  console.log(`Installing Python requirements from ${basename(requirements)}...`)
  const installed = await run(interpreter, ['-m', 'pip', 'install', '-r', requirements])
  if (installed.code !== 0) {
    throw new SetupError(`Installing ${basename(requirements)} into .venv failed ` +
      `(${describeFailure({ ...installed, output: '' })}).`,
    ['See pip\'s messages above (network access, Python version).', RERUN_HINT])
  }
  console.log(`Python environment ready: ${interpreter}`)
}

setupPython().catch((error) => {
  process.exitCode = 1
  const known = error instanceof SetupError
  const lines = [
    'three-maze: Python setup FAILED',
    '',
    known ? error.message : (error && error.stack) || String(error),
    '',
    'The Python backend (experiments, serial port, NI-DAQ, data files) will not run until this',
    'is fixed.',
    ...(known && error.hint.length ? ['', ...error.hint] : [])
  ]
  const rule = '='.repeat(78)
  console.error(['', rule, ...lines.map((line) => (line ? `  ${line}` : '')), rule, ''].join('\n'))
})
