import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import WebSocket from 'ws'
import { SerialPort } from 'serialport'
import { ipcManager } from './scripts/ipc-manager.js'
import { controllerLoader } from './scripts/controller-loader.js'

const isDevelopment = process.env.NODE_ENV === 'development'
const VITE_DEV_SERVER_URL = 'http://localhost:5173'
const userDataPath = app.getPath('userData')
const customScenesPath = path.join(userDataPath, 'customScenes.json')
const displayPreferencePath = path.join(userDataPath, 'displayPreference.json')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow = null
const sceneWindows = new Map()
const sceneConfigs = new Map()
let pythonProcess = null
let pythonWebSocket = null
let serialPort = null
let logStream = null
let preferredDisplayId = null
let waterDeliveryProcess = null

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

async function createSceneWindow(sceneName, sceneConfig, displayId = null) {
  console.log(`Main: Creating scene window for ${sceneName}`)
  console.log('Main: Scene config:', sceneConfig)

  // Store scene config for later reference
  sceneConfigs.set(sceneName, sceneConfig)

  // Determine which display to use
  let targetDisplay = screen.getPrimaryDisplay()
  const allDisplays = screen.getAllDisplays()

  if (displayId !== null) {
    const matchingDisplay = allDisplays.find(d => d.id === displayId)
    if (matchingDisplay) {
      targetDisplay = matchingDisplay
    }
  } else if (preferredDisplayId !== null) {
    const matchingDisplay = allDisplays.find(d => d.id === preferredDisplayId)
    if (matchingDisplay) {
      targetDisplay = matchingDisplay
    }
  } else if (allDisplays.length > 1) {
    // Default to the second display if available and no preference is set
    targetDisplay = allDisplays[1]
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

  // Create and initialize a controller for the scene
  const controllerType = controllerLoader.getControllerTypeForScene(sceneConfig)

  if (controllerType) {
    console.log(`Creating controller of type ${controllerType} for scene ${sceneName}`)
    const controller = controllerLoader.createController(controllerType, sceneConfig)

    if (controller) {
      // Register the controller
      ipcManager.registerController(sceneName, controller)

      // Initialize the controller
      await controller.initialize(sceneWindow)

      // Set up window close event
      sceneWindow.on('close', async () => {
        console.log(`Scene window for ${sceneName} is closing, disposing controller...`)
        await controller.dispose()
        ipcManager.unregisterController(sceneName)
      })
    }
  }

  sceneWindows.set(sceneName, sceneWindow)

  sceneWindow.on('closed', () => {
    console.log(`Scene window for ${sceneName} has been closed`);
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
    // Create user controller directory (if it doesn't exist)
    const userControllerDir = path.join(app.getPath('userData'), 'controllers')
    if (!fs.existsSync(userControllerDir)) {
      fs.mkdirSync(userControllerDir, { recursive: true })
    }

    // Initialize IPC manager
    ipcManager.initialize()

    // In development, load controllers from the project directory
    if (isDevelopment) {
      // Get the controllers directory in the project
      const projectControllersDir = path.join(__dirname, 'scripts', 'controllers')
      console.log(`Development mode: Using project controllers from ${projectControllersDir}`)

      // Only load from user directory if not in development
      console.log('Skipping user controller loading in development mode')
    } else {
      // In production, load from user directory
      console.log(`Production mode: Loading user controllers from ${userControllerDir}`)
      await controllerLoader.loadUserControllers(userControllerDir)
    }

    loadDisplayPreference()
    await createMainWindow()
  } catch (e) {
    console.error('Failed to create main window:', e)
  }
})

app.on('window-all-closed', () => {
  // Clean up IPC manager
  ipcManager.cleanup()

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
    if (sceneName.startsWith('gallery_custom_') || sceneName.startsWith('physics_custom_')) {
      const storedScenes = loadStoredScenes()
      storedScenes[sceneName] = {
        id: sceneName,
        config: sceneConfig
      }
      saveStoredScenes(storedScenes)
    }
  }

  const sceneWindow = await createSceneWindow(sceneName, sceneConfig)
})

ipcMain.handle('get-scene-config', async (event) => {
  const windowId = event.sender.id
  console.log('Main: Received config request from window:', windowId)

  for (const [sceneName, window] of sceneWindows.entries()) {
    if (window.webContents.id === windowId) {
      const config = sceneConfigs.get(sceneName)
      console.log('Main: Found config for scene:', sceneName)
      return { sceneName, config }
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

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error)
})

if (isDevelopment) {
  app.commandLine.appendSwitch('ignore-certificate-errors')
}