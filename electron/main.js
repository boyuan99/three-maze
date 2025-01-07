import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import WebSocket from 'ws'

const isDevelopment = process.env.NODE_ENV === 'development'
const VITE_DEV_SERVER_URL = 'http://localhost:5173'
const userDataPath = app.getPath('userData')
const customScenesPath = path.join(userDataPath, 'customScenes.json')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow = null
const sceneWindows = new Map()
const sceneConfigs = new Map()
let pythonProcess = null
let pythonWebSocket = null

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    titleBarStyle: 'hiddenInset',
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

  const sceneWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    frame: false,
    show: false,
    fullscreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs')
    },
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'hiddenInset'
  })

  sceneWindow.setMenuBarVisibility(false)

  sceneWindow.once('ready-to-show', () => {
    sceneWindow.setFullScreen(true)
    sceneWindow.show()
  })

  try {
    const scenePath = sceneName.startsWith('custom_')
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
    console.log(`Scene window for ${sceneName} is closing`);

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

// App initialization
app.whenReady().then(async () => {
  try {
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

ipcMain.on('open-scene', async (event, sceneName, sceneConfig) => {
  console.log('Main: Received open-scene request for:', sceneName)

  if (sceneConfig) {
    console.log('Main: Storing config for scene:', sceneName)
    sceneConfigs.set(sceneName, sceneConfig)

    // Store custom scenes persistently
    if (sceneName.startsWith('custom_')) {
      const storedScenes = loadStoredScenes()
      storedScenes[sceneName] = {
        id: sceneName,
        config: sceneConfig
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
      const config = sceneConfigs.get(sceneName)
      console.log('Main: Found config for scene:', sceneName)
      // console.log('Main: Returning config:', config)
      return {sceneName, config}
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