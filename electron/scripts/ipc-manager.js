import { ipcMain, app } from 'electron'
import { spawn } from 'child_process'
import WebSocket from 'ws'
import { SerialPort } from 'serialport'
import path from 'path'
import fs from 'fs'

class IpcManager {
  constructor() {
    this.pythonProcess = null
    this.pythonWebSocket = null
    this.serialPort = null
    this.logStream = null
    this.waterDeliveryProcess = null
    this.controllers = new Map() // save controller instances 
    this.rewardCount = new Map() // count rewards for each window
    this.trialStartTime = new Map() // save trial start time for each window
  }

  // initialize IPC communication listeners, only set common IPC handlers here
  // specific scene controllers will add their own IPC listeners through registerController
  initialize() {
    this.setupCommonHandlers()
  }

  // register scene controller, set IPC listeners for specific scenes
  registerController(sceneName, controller) {
    if (this.controllers.has(sceneName)) {
      console.log(`Controller for scene ${sceneName} already registered, replacing...`)
    }

    this.controllers.set(sceneName, controller)
    console.log(`Registered controller for scene: ${sceneName}`)

    // if controller provides setupIpc method, call it to set custom IPC listeners
    if (typeof controller.setupIpc === 'function') {
      controller.setupIpc(ipcMain, this)
    }
  }

  // unregister scene controller, remove IPC listeners for specific scenes
  unregisterController(sceneName) {
    if (this.controllers.has(sceneName)) {
      const controller = this.controllers.get(sceneName)

      // if controller provides cleanupIpc method, call it to clean up IPC listeners
      if (typeof controller.cleanupIpc === 'function') {
        controller.cleanupIpc(ipcMain, this)
      }

      this.controllers.delete(sceneName)
      console.log(`Unregistered controller for scene: ${sceneName}`)
    }
  }

  // set common IPC handlers
  setupCommonHandlers() {
    const safeHandle = (channel, handler) => {
      try {
        ipcMain.handle(channel, handler)
      } catch (error) {
        console.warn(`Handler for ${channel} already exists, skipping...`)
      }
    }

    safeHandle('start-python-serial', async (event) => {
      return this.startPythonSerial(event.sender)
    })

    safeHandle('stop-python-serial', () => {
      return this.stopPythonSerial()
    })

    ipcMain.on('python-data', (event, data) => {
      this.sendToPython(data)
    })

    safeHandle('initialize-js-serial', async () => {
      return this.initializeJsSerial()
    })

    safeHandle('close-js-serial', () => {
      return this.closeJsSerial()
    })

    safeHandle('deliver-water', () => {
      return this.deliverWater()
    })

    safeHandle('append-to-log', (event, data) => {
      return this.appendToLog(data)
    })

    safeHandle('is-serial-scene', (event, scenePath) => {
      return scenePath && (
        scenePath.includes('serial') ||
        scenePath.includes('Serial')
      )
    })
  }

  notifySceneWindow(window, channel, ...args) {
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, ...args)
    }
  }

  getController(sceneName) {
    return this.controllers.get(sceneName)
  }

  initializeCountersForWindow(windowId) {
    this.rewardCount.set(windowId, 0)
    this.trialStartTime.set(windowId, Date.now())
  }

  cleanupCountersForWindow(windowId) {
    this.rewardCount.delete(windowId)
    this.trialStartTime.delete(windowId)
  }

  async startPythonSerial(sender) {
    if (this.pythonProcess) {
      console.log('Python process already running')
      return { success: true }
    }

    try {
      const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3'
      this.pythonProcess = spawn(pythonExecutable, ['-m', 'control.serial_handler'], {
        stdio: ['pipe', 'pipe', 'pipe']
      })

      console.log('Started Python serial process')

      const wss = new WebSocket.Server({ port: 5000 })

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'))
        }, 10000)

        wss.on('connection', (ws) => {
          console.log('WebSocket connected')
          clearTimeout(timeout)
          this.pythonWebSocket = ws

          ws.on('message', (message) => {
            try {
              const data = JSON.parse(message.toString())
              console.log('Received data from Python:', data)
              sender.send('python-serial-data', data)
            } catch (error) {
              console.error('Error parsing message from Python:', error)
            }
          })

          ws.on('close', () => {
            console.log('WebSocket connection closed')
            this.pythonWebSocket = null
          })

          resolve({ success: true })
        })

        this.pythonProcess.stdout.on('data', (data) => {
          console.log(`Python stdout: ${data}`)
        })

        this.pythonProcess.stderr.on('data', (data) => {
          console.error(`Python stderr: ${data}`)
          sender.send('python-error', data.toString())
        })

        this.pythonProcess.on('close', (code) => {
          console.log(`Python process exited with code ${code}`)
          this.pythonProcess = null
          if (this.pythonWebSocket) {
            this.pythonWebSocket.close()
            this.pythonWebSocket = null
          }
          wss.close()
        })
      })
    } catch (error) {
      console.error('Failed to start Python process:', error)
      return { success: false, error: error.message }
    }
  }

  stopPythonSerial() {
    if (this.pythonWebSocket && this.pythonWebSocket.readyState === WebSocket.OPEN) {
      this.pythonWebSocket.send(JSON.stringify({ command: 'stop_logging' }))
      this.pythonWebSocket.close()
      this.pythonWebSocket = null
    }

    if (this.pythonProcess) {
      this.pythonProcess.kill()
      this.pythonProcess = null
    }

    return { success: true }
  }

  sendToPython(data) {
    if (this.pythonWebSocket && this.pythonWebSocket.readyState === WebSocket.OPEN) {
      this.pythonWebSocket.send(JSON.stringify(data))
      return true
    }
    return false
  }

  async initializeJsSerial() {
    try {
      if (this.serialPort) {
        console.log('Serial port already initialized')
        return { success: true }
      }

      const ports = await SerialPort.list()

      if (ports.length === 0) {
        return { success: false, error: 'No serial ports available' }
      }

      let portPath = ports[0].path;

      if (process.platform === 'win32') {
        const com3Port = ports.find(p => p.path === 'COM3');
        if (com3Port) {
          portPath = com3Port.path;
        }
      }

      console.log(`Opening serial port: ${portPath}`);

      this.serialPort = new SerialPort({
        path: portPath,
        baudRate: 115200
      })

      await new Promise((resolve, reject) => {
        this.serialPort.on('open', () => {
          console.log('Serial port opened successfully')
          resolve()
        })

        this.serialPort.on('error', (error) => {
          console.error('Serial port error on open:', error)
          reject(error)
        })
      })

      console.log('Initializing serial with default parameters')
      const initString = "10000,50,10,1\n"
      await this.serialPort.write(initString)

      this.serialPort.on('data', (data) => {
        try {
          const line = data.toString().trim()
          const values = line.split(',')

          if (values.length >= 13) {
            const serialData = {
              timestamp: values[0],
              leftSensor: {
                dx: parseFloat(values[1]),
                dy: parseFloat(values[2]),
                dt: parseFloat(values[3])
              },
              rightSensor: {
                dx: parseFloat(values[4]),
                dy: parseFloat(values[5]),
                dt: parseFloat(values[6])
              },
              x: parseFloat(values[7]),
              y: parseFloat(values[8]),
              theta: parseFloat(values[9]),
              water: parseInt(values[10]),
              direction: parseFloat(values[11]),
              frameCount: parseInt(values[12])
            }

            for (const controller of this.controllers.values()) {
              if (controller.window && !controller.window.isDestroyed()) {
                controller.sendToScene('serial-data', serialData)
              }
            }
          }
        } catch (error) {
          console.error('Error parsing serial data:', error)
        }
      })

      this.serialPort.on('error', (err) => {
        console.error('Serial port error:', err)
      })

      const logDir = path.join(app.getPath('userData'), 'logs')
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
      }

      const timestamp = new Date().toISOString().replace(/:/g, '-')
      const logFile = path.join(logDir, `serial_${timestamp}.log`)
      this.logStream = fs.createWriteStream(logFile, { flags: 'a' })

      console.log(`Created serial log file: ${logFile}`)

      return { success: true, port: portPath }
    } catch (error) {
      console.error('Failed to initialize serial port:', error)
      return { success: false, error: error.message }
    }
  }

  async closeJsSerial() {
    return new Promise((resolve) => {
      try {
        const cleanup = () => {
          if (this.logStream) {
            this.logStream.end()
            this.logStream = null
          }
          this.serialPort = null
          resolve({ success: true })
        }

        if (this.serialPort && this.serialPort.isOpen) {
          console.log('Closing serial port...')
          this.serialPort.close((err) => {
            if (err) {
              console.error('Error closing serial port:', err)
            } else {
              console.log('Serial port closed successfully')
            }
            cleanup()
          })
        } else {
          console.log('Serial port was already closed')
          cleanup()
        }
      } catch (error) {
        console.error('Error in closeJsSerial:', error)
        resolve({ success: false, error: error.message })
      }
    })
  }

  appendToLog(data) {
    try {
      if (!this.logStream) {
        const logDir = path.join(app.getPath('userData'), 'logs')
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true })
        }

        const logFile = path.join(logDir, `log_${new Date().toISOString().replace(/:/g, '-')}.txt`)
        this.logStream = fs.createWriteStream(logFile, { flags: 'a' })
      }

      this.logStream.write(data + '\n')
      return true
    } catch (error) {
      console.error('Error appending to log:', error)
      return false
    }
  }

  deliverWater() {
    try {
      console.log('Delivering water reward')

      for (const controller of this.controllers.values()) {
        if (controller.deliverReward && typeof controller.deliverReward === 'function') {
          return controller.deliverReward()
        }
      }

      return { success: true }
    } catch (error) {
      console.error('Error delivering water:', error)
      return { success: false, error: error.message }
    }
  }

  cleanup() {
    this.stopPythonSerial()
    this.closeJsSerial()

    if (this.logStream) {
      this.logStream.end()
      this.logStream = null
    }

    this.controllers.clear()
    this.rewardCount.clear()
    this.trialStartTime.clear()
  }
}

export const ipcManager = new IpcManager() 