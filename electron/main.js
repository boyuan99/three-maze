import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import WebSocket from 'ws'
// SerialPort now managed by HardwareManager
import { ExperimentManager } from '../src/core/ExperimentManager.js'
import { HardwareManager } from '../src/core/HardwareManager.js'

const isDevelopment = process.env.NODE_ENV === 'development'
const VITE_DEV_SERVER_URL = 'http://localhost:5173'
const userDataPath = app.getPath('userData')
const customScenesPath = path.join(userDataPath, 'customScenes.json')
const controlFilesPath = path.join(userDataPath, 'controlFiles.json')
const displayPreferencePath = path.join(userDataPath, 'displayPreference.json')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow = null
const sceneWindows = new Map()
const sceneConfigs = new Map()
let pythonProcess = null
let pythonWebSocket = null
let preferredDisplayId = null
let rewardCount = new Map()
let trialStartTime = new Map()
// All hardware management now handled by HardwareManager and user-defined experiments

// Core managers for new modular architecture
let experimentManager = null
let hardwareManager = null

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    titleBarStyle: 'default',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs')
    },
    backgroundColor: '#1a1a1a'
  })

  mainWindow.setMenuBarVisibility(false)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  try {
    if (isDevelopment) {
      console.log('Loading dev server URL:', VITE_DEV_SERVER_URL)
      await mainWindow.loadURL(VITE_DEV_SERVER_URL)
    } else {
      const indexHtml = join(process.resourcesPath, 'app', 'dist', 'index.html')
      console.log('Loading production file:', indexHtml)
      await mainWindow.loadFile(indexHtml)
    }
  } catch (e) {
    console.error('Failed to load main window:', e)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      app.quit()
    }
  })

  // Initialize core managers after mainWindow is ready
  try {
    experimentManager = new ExperimentManager(mainWindow, ipcMain)
    hardwareManager = new HardwareManager()
    console.log('Core managers initialized successfully')
  } catch (error) {
    console.error('Failed to initialize core managers:', error)
  }

  return mainWindow
}

async function createSceneWindow(sceneName) {
  console.log('Main: Creating window for scene:', sceneName)
  const hasConfig = sceneConfigs.has(sceneName)
  console.log('Main: Has config:', hasConfig)

  if (sceneWindows.has(sceneName)) {
    const existingWindow = sceneWindows.get(sceneName)
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.focus()
      return existingWindow
    }
  }

  // Get all displays
  const displays = screen.getAllDisplays()
  const primaryDisplay = screen.getPrimaryDisplay()

  let targetDisplay
  if (preferredDisplayId !== null) {
    targetDisplay = displays.find(display => display.id === preferredDisplayId)
  }
  if (!targetDisplay) {
    targetDisplay = displays.find(display => display.id !== primaryDisplay.id) || primaryDisplay
  }

  const windowOptions = {
    width: 1024,
    height: 768,
    frame: true,
    show: false,
    fullscreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs')
    },
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'default'
  }

  // Set window position and size for target display
  windowOptions.x = targetDisplay.bounds.x
  windowOptions.y = targetDisplay.bounds.y
  windowOptions.width = targetDisplay.bounds.width
  windowOptions.height = targetDisplay.bounds.height

  const sceneWindow = new BrowserWindow(windowOptions)

  sceneWindow.setMenuBarVisibility(false)

  sceneWindow.once('ready-to-show', () => {
    sceneWindow.setFullScreen(true)
    sceneWindow.show()
  })

  try {
    const scenePath = sceneName.startsWith('gallery_custom_') ||
      sceneName.startsWith('physics_custom_') ||
      sceneName.startsWith('serial_custom_')
      ? `scene/custom/${sceneName}`
      : `scene/${sceneName}`

    const url = isDevelopment
      ? `${VITE_DEV_SERVER_URL}/#/${scenePath}`
      : `file://${join(__dirname, '../dist/index.html')}#/${scenePath}`

    console.log('Main: Loading scene URL:', url)
    await sceneWindow.loadURL(url)
  } catch (e) {
    console.error('Main: Failed to load scene:', e)
    sceneWindow.close()
    return null
  }

  // Initialize counters for this window
  rewardCount.set(sceneWindow.id, 0)
  trialStartTime.set(sceneWindow.id, Date.now())

  sceneWindows.set(sceneName, sceneWindow)

  sceneWindow.on('closed', () => {
    console.log(`Scene window for ${sceneName} has been closed`);
    sceneWindows.delete(sceneName)
    sceneConfigs.delete(sceneName)
  })

  sceneWindow.on('close', () => {
    console.log(`Scene window for ${sceneName} is closing`)
    console.log(`Total rewards earned: ${rewardCount.get(sceneWindow.id)}`)

    // Clean up counters
    rewardCount.delete(sceneWindow.id)
    trialStartTime.delete(sceneWindow.id)

    // Send 'stop_logging' via WebSocket
    if (pythonWebSocket && pythonWebSocket.readyState === WebSocket.OPEN) {
      pythonWebSocket.send(JSON.stringify({ command: 'stop_logging' }));
      pythonWebSocket.close();
      pythonWebSocket = null;
    }

    // Kill the Python process if it's still running
    if (pythonProcess) {
      pythonProcess.kill();
      pythonProcess = null;
    }

    sceneWindows.delete(sceneName);
    sceneConfigs.delete(sceneName);
  })

  return sceneWindow
}

function loadStoredScenes() {
  try {
    if (fs.existsSync(customScenesPath)) {
      const data = fs.readFileSync(customScenesPath, 'utf8')
      return JSON.parse(data)
    }
  } catch (error) {
    console.error('Error loading stored scenes:', error)
  }
  return {}
}

function saveStoredScenes(scenes) {
  try {
    fs.writeFileSync(customScenesPath, JSON.stringify(scenes, null, 2))
  } catch (error) {
    console.error('Error saving stored scenes:', error)
  }
}

function loadStoredControlFiles() {
  try {
    if (fs.existsSync(controlFilesPath)) {
      const data = fs.readFileSync(controlFilesPath, 'utf8')
      return JSON.parse(data)
    }
  } catch (error) {
    console.error('Error loading stored control files:', error)
  }
  return {}
}

function saveStoredControlFiles(controlFiles) {
  try {
    fs.writeFileSync(controlFilesPath, JSON.stringify(controlFiles, null, 2))
  } catch (error) {
    console.error('Error saving stored control files:', error)
  }
}

function loadDisplayPreference() {
  try {
    if (fs.existsSync(displayPreferencePath)) {
      const data = fs.readFileSync(displayPreferencePath, 'utf8')
      const preference = JSON.parse(data)
      preferredDisplayId = Number(preference.displayId)
    }
  } catch (error) {
    console.error('Error loading display preference:', error)
  }
}

function saveDisplayPreference(displayId) {
  try {
    const data = JSON.stringify({ displayId: Number(displayId) }, null, 2)
    fs.writeFileSync(displayPreferencePath, data)
  } catch (error) {
    console.error('Error saving display preference:', error)
  }
}

// App initialization
app.whenReady().then(async () => {
  try {
    loadDisplayPreference()
    await createMainWindow()
  } catch (e) {
    console.error('Failed to create main window:', e)
  }
})

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', async () => {
  if (mainWindow === null) {
    await createMainWindow()
  }
})

ipcMain.on('open-scene', async (event, sceneName, sceneData) => {
  console.log('Main: Received open-scene request for:', sceneName)

  if (sceneData) {
    console.log('Main: Storing data for scene:', sceneName)

    // Handle both old format (just config) and new format (config + controlFile)
    if (sceneData.config || sceneData.controlFile) {
      // New format with config and controlFile
      sceneConfigs.set(sceneName, sceneData)
    } else {
      // Old format - just config
      sceneConfigs.set(sceneName, { config: sceneData })
    }

    // Store custom scenes persistently (only the scene config, not control files)
    if (sceneName.startsWith('gallery_custom_') || sceneName.startsWith('physics_custom_') || sceneName.startsWith('serial_custom_')) {
      const storedScenes = loadStoredScenes()
      storedScenes[sceneName] = {
        id: sceneName,
        config: sceneData.config || sceneData
      }
      saveStoredScenes(storedScenes)
    }
  }

  const sceneWindow = await createSceneWindow(sceneName)

  // Auto-start Python backend for serial scenes
  if (sceneName.startsWith('serial-')) {
    try {
      await startPythonBackend(sceneWindow)
    } catch (error) {
      sceneWindow.webContents.send('python-error', error.message)
    }
  }
})

ipcMain.handle('get-scene-config', async (event) => {
  const windowId = event.sender.id
  console.log('Main: Received config request from window:', windowId)

  for (const [sceneName, window] of sceneWindows.entries()) {
    if (window.webContents.id === windowId) {
      const sceneData = sceneConfigs.get(sceneName)
      console.log('Main: Found data for scene:', sceneName)

      // Return the full scene data (config + controlFile if available)
      if (sceneData && sceneData.config) {
        // New format
        return {
          sceneName,
          config: sceneData.config,
          controlFile: sceneData.controlFile || null
        }
      } else if (sceneData) {
        // Old format - just config
        return {
          sceneName,
          config: sceneData,
          controlFile: null
        }
      }
    }
  }

  console.log('Main: No config found for window:', windowId)
  return null
})

ipcMain.handle('store-custom-scene', async (event, sceneData) => {
  const storedScenes = loadStoredScenes()
  storedScenes[sceneData.id] = sceneData
  saveStoredScenes(storedScenes)
  return true
})

ipcMain.handle('get-stored-scenes', async () => {
  return loadStoredScenes()
})

ipcMain.handle('delete-stored-scene', async (event, sceneId) => {
  const storedScenes = loadStoredScenes()
  delete storedScenes[sceneId]
  saveStoredScenes(storedScenes)
  return true
})

ipcMain.handle('store-control-file', async (event, sceneId, controlFileData) => {
  try {
    const storedControlFiles = loadStoredControlFiles()
    storedControlFiles[sceneId] = controlFileData
    saveStoredControlFiles(storedControlFiles)
    return true
  } catch (error) {
    console.error('Error storing control file:', error)
    return false
  }
})

ipcMain.handle('get-stored-control-files', async () => {
  return loadStoredControlFiles()
})

ipcMain.handle('delete-control-file', async (event, sceneId) => {
  try {
    const storedControlFiles = loadStoredControlFiles()
    delete storedControlFiles[sceneId]
    saveStoredControlFiles(storedControlFiles)
    return true
  } catch (error) {
    console.error('Error deleting control file:', error)
    return false
  }
})

const getPythonConfig = () => {
  const platform = process.platform
  const venvPath = path.join(__dirname, '../.venv')

  switch (platform) {
    case 'win32':
      return {
        interpreter: path.join(venvPath, 'Scripts', 'python.exe'),
        pip: path.join(venvPath, 'Scripts', 'pip.exe'),
        venvCommand: ['python', '-m', 'venv'],
        requirements: ['pyserial', 'numpy', 'nidaqmx']
      }
    case 'darwin':
      return {
        interpreter: path.join(venvPath, 'bin', 'python3'),
        pip: path.join(venvPath, 'bin', 'pip3'),
        venvCommand: ['python3', '-m', 'venv'],
        requirements: ['pyserial', 'numpy', 'nidaqmx']
      }
    case 'linux':
      return {
        interpreter: path.join(venvPath, 'bin', 'python3'),
        pip: path.join(venvPath, 'bin', 'pip3'),
        venvCommand: ['python3', '-m', 'venv'],
        requirements: ['pyserial', 'numpy', 'nidaqmx']
      }
    default:
      throw new Error(`Unsupported platform: ${platform}`)
  }
}

ipcMain.handle('start-python-serial', async (event) => {
  try {
    const window = BrowserWindow.fromWebContents(event.sender);
    await startPythonBackend(window);
    return true;
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('stop-python-serial', async () => {
  if (pythonWebSocket && pythonWebSocket.readyState === WebSocket.OPEN) {
    pythonWebSocket.send(JSON.stringify({ command: 'stop_logging' }));
    pythonWebSocket.close();
    pythonWebSocket = null;
  }
  if (pythonProcess) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    pythonProcess.kill();
    pythonProcess = null;
  }
  return true;
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error)
})

if (isDevelopment) {
  app.commandLine.appendSwitch('ignore-certificate-errors')
}

const startPythonBackend = async (window) => {
  try {
    if (pythonProcess) {
      pythonProcess.kill();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const config = getPythonConfig()
    const scriptPath = path.join(__dirname, '..')

    if (!fs.existsSync(config.interpreter)) {
      throw new Error('Python environment not found. Please run setup first.')
    }

    // Start the Python backend
    pythonProcess = spawn(config.interpreter, ['-m', 'control.hallway'], {
      cwd: scriptPath,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    // Wait for the WebSocket server to start
    await new Promise((resolve, reject) => {
      let serverStarted = false;

      pythonProcess.stdout.on('data', (data) => {
        const message = data.toString()
        console.log('Python output:', message)
        if (message.includes('WebSocket server started')) {
          serverStarted = true;
          resolve()
        }
      })

      pythonProcess.stderr.on('data', (data) => {
        console.error('Python error:', data.toString())
      })

      pythonProcess.on('exit', (code) => {
        console.log(`Python process exited with code ${code}`)
        if (!serverStarted) {
          reject(new Error('Python backend failed to start'))
        }
      })
    })

    // Establish WebSocket connection
    pythonWebSocket = new WebSocket('ws://localhost:8765')

    pythonWebSocket.on('open', () => {
      console.log('WebSocket connection established with Python backend')
    })

    pythonWebSocket.on('message', (message) => {
      try {
        const parsedData = JSON.parse(message)
        if (parsedData.type === 'serial_data') {
          window.webContents.send('python-serial-data', parsedData.data)
        } else {
          console.log('Received from Python:', parsedData)
        }
      } catch (error) {
        console.error('Failed to parse message from Python:', message)
      }
    })

    pythonWebSocket.on('close', () => {
      console.log('WebSocket connection closed')
    })

    pythonWebSocket.on('error', (error) => {
      console.error('WebSocket error:', error)
    })

    // Handle data from the renderer process to Python backend
    ipcMain.on('python-data', (event, data) => {
      if (pythonWebSocket && pythonWebSocket.readyState === WebSocket.OPEN) {
        pythonWebSocket.send(JSON.stringify(data));
      } else {
        console.error('WebSocket is not open');
      }
    })

    return true
  } catch (error) {
    console.error('Failed to start Python backend:', error)

    pythonProcess = null;
    throw error;
  }
}

// Removed hardcoded 'initialize-js-serial' handler - now defined in experiment files

// Removed hardcoded 'append-to-log' handler - now defined in experiment files

// Removed hardcoded 'close-js-serial' handler - now defined in experiment files

// Legacy water delivery service function removed - now handled by HardwareManager

// Removed hardcoded 'deliver-water' handler - now defined in experiment files

ipcMain.handle('get-displays', () => {
  const displays = screen.getAllDisplays()
  return displays.map(display => ({
    id: display.id,
    isPrimary: display.bounds.x === 0 && display.bounds.y === 0,
    bounds: display.bounds
  }))
})

ipcMain.on('set-preferred-display', (event, displayId) => {
  preferredDisplayId = Number(displayId)
  saveDisplayPreference(preferredDisplayId)

  BrowserWindow.getAllWindows().forEach(window => {
    window.webContents.send('display-changed', preferredDisplayId)
  })
})

ipcMain.handle('get-preferred-display', () => {
  return preferredDisplayId
})

ipcMain.on('reward-delivered', (event) => {
  const windowId = BrowserWindow.fromWebContents(event.sender).id
  const currentCount = rewardCount.get(windowId) || 0
  const currentTime = Date.now()
  const trialTime = (currentTime - trialStartTime.get(windowId)) / 1000 // Convert to seconds

  rewardCount.set(windowId, currentCount + 1)
  console.log(`Reward #${currentCount + 1} delivered! Trial time: ${trialTime.toFixed(2)} seconds`)

  // Reset trial timer for next trial
  trialStartTime.set(windowId, currentTime)
})

// ============================================================================
// NEW MODULAR ARCHITECTURE IPC HANDLERS
// ============================================================================

ipcMain.handle('load-experiment', async (event, experimentPath, sceneConfig) => {
  try {
    if (!experimentManager) {
      throw new Error('ExperimentManager not initialized')
    }
    
    console.log('Loading experiment:', experimentPath)
    const result = await experimentManager.loadExperiment(experimentPath, sceneConfig)
    return { success: true, experiment: result }
  } catch (error) {
    console.error('Failed to load experiment:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('unload-experiment', async (event) => {
  try {
    if (!experimentManager) {
      throw new Error('ExperimentManager not initialized')
    }
    
    const result = await experimentManager.unloadExperiment()
    return { success: true, result }
  } catch (error) {
    console.error('Failed to unload experiment:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('request-hardware', async (event, type, config) => {
  try {
    if (!hardwareManager) {
      throw new Error('HardwareManager not initialized')
    }
    
    const experimentId = experimentManager?.getActiveExperiment()?.name || 'default'
    console.log(`Requesting hardware resource: ${type} for experiment: ${experimentId}`)
    
    const handle = await hardwareManager.requestResource(type, config, experimentId)
    return { success: true, handle }
  } catch (error) {
    console.error('Failed to request hardware:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('release-hardware', async (event, handle) => {
  try {
    if (!hardwareManager) {
      throw new Error('HardwareManager not initialized')
    }
    
    const result = await hardwareManager.releaseResource(handle)
    return { success: true, result }
  } catch (error) {
    console.error('Failed to release hardware:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('get-active-experiment', async (event) => {
  try {
    if (!experimentManager) {
      return { success: false, error: 'ExperimentManager not initialized' }
    }
    
    const experiment = experimentManager.getActiveExperiment()
    return { success: true, experiment }
  } catch (error) {
    console.error('Failed to get active experiment:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('validate-experiment', async (event, experimentPath) => {
  try {
    if (!experimentManager) {
      throw new Error('ExperimentManager not initialized')
    }
    
    const result = await experimentManager.validateExperiment(experimentPath)
    return { success: true, result }
  } catch (error) {
    console.error('Failed to validate experiment:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('list-hardware', async (event) => {
  try {
    if (!hardwareManager) {
      throw new Error('HardwareManager not initialized')
    }
    
    const resources = await hardwareManager.listResources()
    return { success: true, resources }
  } catch (error) {
    console.error('Failed to list hardware:', error)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('hardware-status', async (event) => {
  try {
    if (!hardwareManager) {
      throw new Error('HardwareManager not initialized')
    }
    
    const status = await hardwareManager.getStatus()
    return { success: true, status }
  } catch (error) {
    console.error('Failed to get hardware status:', error)
    return { success: false, error: error.message }
  }
})

