import { app, BrowserWindow, ipcMain, screen, dialog } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

const isDevelopment = process.env.NODE_ENV === 'development'
// Read Vite port from environment variable (set by start script)
const VITE_DEV_SERVER_PORT = process.env.VITE_DEV_SERVER_PORT || '5173'
const VITE_DEV_SERVER_URL = `http://localhost:${VITE_DEV_SERVER_PORT}`
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
let detectedWsPort = null  // Dynamically detected WebSocket port
let preferredDisplayId = null

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

  sceneWindows.set(sceneName, sceneWindow)

  sceneWindow.on('closed', () => {
    console.log(`Scene window for ${sceneName} has been closed`);
    sceneWindows.delete(sceneName)
    sceneConfigs.delete(sceneName)
  })

  sceneWindow.on('close', () => {
    console.log(`Scene window for ${sceneName} is closing`)
    sceneWindows.delete(sceneName)
    sceneConfigs.delete(sceneName)
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

    // Start Python backend in both dev and production modes
    console.log('Starting Python WebSocket backend...')
    await startPythonBackend()

    await createMainWindow()
  } catch (e) {
    console.error('Failed to initialize app:', e)
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
    console.log('Main: Scene data:', sceneData)

    // Handle both old format (just config) and new format (config + experimentFile)
    if (sceneData.config || sceneData.experimentFile) {
      // New format with config and experimentFile
      sceneConfigs.set(sceneName, sceneData)
    } else {
      // Old format - just config
      sceneConfigs.set(sceneName, { config: sceneData })
    }

    // Store custom scenes persistently (only the scene config)
    if (sceneName.startsWith('gallery_custom_') || sceneName.startsWith('physics_custom_') || sceneName.startsWith('serial_custom_')) {
      const storedScenes = loadStoredScenes()
      storedScenes[sceneName] = {
        id: sceneName,
        config: sceneData.config || sceneData
      }
      saveStoredScenes(storedScenes)
    }
  }

  await createSceneWindow(sceneName)
})

// Expose WebSocket port to renderer
ipcMain.handle('get-ws-port', () => {
  // Return detected port or default
  return detectedWsPort || '8765'
})

ipcMain.handle('get-scene-config', async (event) => {
  const windowId = event.sender.id
  console.log('Main: Received config request from window:', windowId)

  for (const [sceneName, window] of sceneWindows.entries()) {
    if (window.webContents.id === windowId) {
      const sceneData = sceneConfigs.get(sceneName)
      console.log('Main: Found data for scene:', sceneName)

      // Return the full scene data (config + experimentFile if available)
      if (sceneData && sceneData.config) {
        // New format
        return {
          sceneName,
          config: sceneData.config,
          experimentFile: sceneData.experimentFile || null
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


process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error)
})

if (isDevelopment) {
  app.commandLine.appendSwitch('ignore-certificate-errors')
}

const startPythonBackend = async () => {
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

    // Start the Python WebSocket backend
    pythonProcess = spawn(config.interpreter, ['-m', 'backend.src.main'], {
      cwd: scriptPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1'  // Disable Python output buffering
      }
    })

    // Wait for the WebSocket server to start and capture the port
    await new Promise((resolve, reject) => {
      let serverStarted = false;

      pythonProcess.stdout.on('data', (data) => {
        const message = data.toString()

        // Look for pattern: "WebSocket server ready on port 8765"
        const portMatch = message.match(/WebSocket server ready on port (\d+)/i)
        if (portMatch && !detectedWsPort) {
          const port = parseInt(portMatch[1])
          // Validate port is in reasonable range (8765-8775)
          if (port >= 8765 && port <= 8775) {
            detectedWsPort = port.toString()
            serverStarted = true
            console.log(`Python WebSocket backend ready on port ${detectedWsPort}`)
            resolve()
          }
        }

        // Fallback: old-style detection (for compatibility)
        if (message.includes('WebSocket server started') && !serverStarted) {
          detectedWsPort = '8765'  // Default port
          serverStarted = true
          resolve()
        }
      })

      pythonProcess.stderr.on('data', (data) => {
        const message = data.toString()
        // Only log errors/warnings, not routine INFO messages
        if (message.includes('ERROR') || message.includes('WARNING') || message.includes('Traceback')) {
          console.log('Python:', message)
        }

        // Look for port in stderr too
        const portMatch = message.match(/WebSocket server ready on port (\d+)/i)
        if (portMatch && !detectedWsPort) {
          const port = parseInt(portMatch[1])
          if (port >= 8765 && port <= 8775) {
            detectedWsPort = port.toString()
            serverStarted = true
            console.log(`Python WebSocket backend ready on port ${detectedWsPort}`)
            resolve()
          }
        }
      })

      pythonProcess.on('exit', (code) => {
        console.log(`Python process exited with code ${code}`)
        if (!serverStarted) {
          reject(new Error('Python backend failed to start'))
        }
      })

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!serverStarted) {
          reject(new Error('Python backend startup timeout'))
        }
      }, 30000)
    })

    console.log('Python backend started successfully')
    return true
  } catch (error) {
    console.error('Failed to start Python backend:', error)
    pythonProcess = null
    detectedWsPort = null
    throw error
  }
}


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

// File dialog handlers with default paths
ipcMain.handle('select-maze-file', async () => {
  const projectRoot = isDevelopment ? process.cwd() : path.join(process.resourcesPath, 'app')
  const defaultPath = path.join(projectRoot, 'mazes')

  const result = await dialog.showOpenDialog({
    title: 'Select Maze JSON File',
    defaultPath: defaultPath,
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ],
    properties: ['openFile']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const filePath = result.filePaths[0]
  const fileName = path.basename(filePath)
  const content = fs.readFileSync(filePath, 'utf8')

  return {
    name: fileName,
    path: filePath,
    content: content
  }
})

ipcMain.handle('select-experiment-file', async () => {
  const projectRoot = isDevelopment ? process.cwd() : path.join(process.resourcesPath, 'app')
  const defaultPath = path.join(projectRoot, 'experiments')

  const result = await dialog.showOpenDialog({
    title: 'Select Python Experiment File',
    defaultPath: defaultPath,
    filters: [
      { name: 'Python Files', extensions: ['py'] }
    ],
    properties: ['openFile']
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const filePath = result.filePaths[0]
  const fileName = path.basename(filePath)
  const content = fs.readFileSync(filePath, 'utf8')

  return {
    name: fileName,
    path: filePath,
    content: content
  }
})



