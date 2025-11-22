#!/usr/bin/env node

/**
 * Smart development startup script
 *
 * This script:
 * 1. Starts Vite dev server
 * 2. Captures the actual port Vite is using (handles auto-port-switching)
 * 3. Passes the port to Electron via environment variable
 * 4. Starts Electron when Vite is ready
 * 5. Handles graceful shutdown of both processes
 */

import { spawn, exec } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import http from 'http'
import { platform } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let viteProcess = null
let electronProcess = null
let vitePort = null
let isShuttingDown = false

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
}

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`)
}

/**
 * Start Vite dev server and capture the port from stdout
 */
function startVite() {
  return new Promise((resolve, reject) => {
    log('\n[START] Starting Vite dev server...', colors.cyan)

    viteProcess = spawn('npm', ['run', 'dev'], {
      cwd: __dirname,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '1'  // Preserve colors in output
      }
    })

    viteProcess.stdout.on('data', (data) => {
      const text = data.toString()

      // Forward Vite output to console
      process.stdout.write(text)

      // Parse the actual port from Vite output
      // Look for patterns like:
      //   "Local:   http://localhost:5173/"
      //   "  ➜  Local:   http://localhost:5173/"
      // Strip ANSI color codes before matching
      const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '')

      // Try multiple patterns to be robust
      const patterns = [
        /Local:\s+http:\/\/localhost:(\d+)/i,
        /localhost:(\d+)/i,
        /:\s*(\d{4,5})\s*\//  // Match port numbers followed by /
      ]

      for (const pattern of patterns) {
        const portMatch = cleanText.match(pattern)
        if (portMatch && !vitePort) {
          const detectedPort = parseInt(portMatch[1])
          // Validate port is in reasonable range (5173-5200)
          if (detectedPort >= 5173 && detectedPort <= 5200) {
            vitePort = detectedPort
            log(`\n[SUCCESS] Vite is ready on port ${vitePort}`, colors.green + colors.bright)
            resolve(vitePort)
            break
          }
        }
      }
    })

    viteProcess.stderr.on('data', (data) => {
      process.stderr.write(data)
    })

    viteProcess.on('error', (err) => {
      log(`[ERROR] Failed to start Vite: ${err.message}`, colors.red)
      reject(err)
    })

    viteProcess.on('exit', (code) => {
      if (!isShuttingDown) {
        log(`\n[WARNING] Vite process exited with code ${code}`, colors.yellow)
        cleanup(code)
      }
    })

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!vitePort) {
        reject(new Error('Vite failed to start within 30 seconds'))
      }
    }, 30000)
  })
}

/**
 * Wait for Vite server to be ready by checking HTTP connection
 */
async function waitForVite(port, maxAttempts = 30) {
  log(`\n[WAIT] Waiting for Vite server to be ready on port ${port}...`, colors.yellow)

  for (let i = 0; i < maxAttempts; i++) {
    const isReady = await checkPort(port)

    if (isReady) {
      log(`[SUCCESS] Vite server is ready!`, colors.green)
      return true
    }

    // Wait 500ms before next attempt
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  throw new Error(`Vite server did not respond after ${maxAttempts * 0.5} seconds`)
}

/**
 * Check if port is responding to HTTP requests
 */
function checkPort(port) {
  return new Promise((resolve) => {
    const options = {
      host: 'localhost',
      port: port,
      path: '/',
      method: 'GET',
      timeout: 500
    }

    const req = http.request(options, () => {
      // Any response means server is ready
      resolve(true)
    })

    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })

    req.end()
  })
}

/**
 * Start Electron with the detected Vite port
 */
function startElectron(port) {
  return new Promise((resolve, reject) => {
    log(`\n[START] Starting Electron with Vite port ${port}...`, colors.cyan)

    electronProcess = spawn('electron', ['.'], {
      cwd: __dirname,
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_DEV_SERVER_PORT: port.toString()
      }
    })

    electronProcess.on('error', (err) => {
      log(`[ERROR] Failed to start Electron: ${err.message}`, colors.red)
      reject(err)
    })

    electronProcess.on('exit', (code) => {
      if (!isShuttingDown) {
        log(`\n[WARNING] Electron exited with code ${code}`, colors.yellow)
        cleanup(code)
      }
    })

    // Give Electron a moment to start
    setTimeout(() => {
      log(`[SUCCESS] Electron started successfully`, colors.green)
      resolve()
    }, 1000)
  })
}

/**
 * Kill a process tree (handles Windows/macOS/Linux)
 *
 * Cross-platform process tree termination:
 *
 * Windows:
 *   - Uses `taskkill /T /F` to recursively kill entire process tree
 *   - Required because spawn({shell: true}) creates cmd.exe -> node.exe hierarchy
 *
 * macOS:
 *   - Uses `pkill -P <pid>` to kill all child processes
 *   - Then kills parent with `kill <pid>`
 *   - Fallback to direct process.kill() if pkill unavailable
 *
 * Linux:
 *   - First attempts `process.kill(-pid)` to kill process group
 *   - Negative PID targets the entire process group
 *   - Falls back to pkill method if process group kill fails
 *
 * @param {number} pid - Process ID to kill
 * @param {string} signal - Signal to send (default: SIGTERM)
 * @returns {Promise<void>}
 */
function killProcessTree(pid, signal = 'SIGTERM') {
  return new Promise((resolve) => {
    const isWin = platform() === 'win32'
    const isMac = platform() === 'darwin'

    if (isWin) {
      // Windows: Use taskkill to kill entire process tree
      exec(`taskkill /pid ${pid} /T /F`, (error) => {
        if (error) {
          log(`  - Process ${pid} already terminated`, colors.yellow)
        }
        resolve()
      })
    } else if (isMac) {
      // macOS: Use pkill to find and kill child processes
      // First kill children, then parent
      exec(`pkill -P ${pid}; kill ${pid}`, (error) => {
        if (error) {
          // Try direct kill if pkill fails
          try {
            process.kill(pid, signal)
          } catch (err) {
            // Process already dead
          }
        }
        resolve()
      })
    } else {
      // Linux: Try process group kill first, fallback to pkill
      try {
        // Negative PID kills the process group
        process.kill(-pid, signal)
        resolve()
      } catch (err) {
        // Fallback: use pkill to kill child processes
        exec(`pkill -P ${pid}; kill ${pid}`, (error) => {
          if (error) {
            // Process already dead
          }
          resolve()
        })
      }
    }
  })
}

/**
 * Kill a process and wait for it to exit
 */
function killProcess(proc, name, timeout = 3000) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) {
      resolve()
      return
    }

    log(`  - Stopping ${name}...`, colors.yellow)

    let hasExited = false

    const timeoutId = setTimeout(async () => {
      if (!hasExited && !proc.killed) {
        log(`  - Force killing ${name}...`, colors.red)
        await killProcessTree(proc.pid, 'SIGKILL')
      }
    }, timeout)

    proc.on('exit', () => {
      hasExited = true
      clearTimeout(timeoutId)
      log(`  - ${name} stopped`, colors.green)
      resolve()
    })

    // Kill the process tree
    killProcessTree(proc.pid).catch((err) => {
      log(`  - Error killing ${name}: ${err.message}`, colors.red)
      resolve()
    })
  })
}

/**
 * Cleanup and shutdown both processes
 */
async function cleanup(exitCode = 0) {
  if (isShuttingDown) return
  isShuttingDown = true

  log('\n\n[SHUTDOWN] Shutting down...', colors.yellow)

  // Kill both processes and wait for them to exit
  await Promise.all([
    killProcess(electronProcess, 'Electron'),
    killProcess(viteProcess, 'Vite')
  ])

  log('[SUCCESS] Cleanup complete\n', colors.green)
  process.exit(exitCode)
}

/**
 * Handle termination signals
 */
process.on('SIGINT', () => {
  log('\n\n[SIGNAL] Received SIGINT (Ctrl+C)', colors.yellow)
  cleanup(0)
})

process.on('SIGTERM', () => {
  log('\n\n[SIGNAL] Received SIGTERM', colors.yellow)
  cleanup(0)
})

process.on('exit', () => {
  if (!isShuttingDown) {
    cleanup(0)
  }
})

/**
 * Main execution
 */
async function main() {
  try {
    log('='.repeat(60), colors.blue)
    log('  Three-Maze Development Server', colors.bright + colors.blue)
    log('='.repeat(60), colors.blue)

    // Step 1: Start Vite and capture port
    const port = await startVite()

    // Step 2: Wait for Vite to be fully ready
    await waitForVite(port)

    // Step 3: Start Electron with the detected port
    await startElectron(port)

    log('\n' + '='.repeat(60), colors.green)
    log('  [SUCCESS] Development environment ready!', colors.bright + colors.green)
    log(`  [INFO] Vite dev server: http://localhost:${port}`, colors.green)
    log(`  [INFO] Electron window should now be open`, colors.green)
    log('='.repeat(60), colors.green)
    log('\n[INFO] Press Ctrl+C to stop both servers\n', colors.cyan)

  } catch (err) {
    log(`\n[ERROR] ${err.message}`, colors.red)
    cleanup(1)
  }
}

// Start the application
main()
