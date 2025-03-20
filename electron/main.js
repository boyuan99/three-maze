import { app, BrowserWindow, ipcMain, screen, dialog } from 'electron'
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
const controllerFilesPath = path.join(userDataPath, 'controllerFiles.json')

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

    await sceneWindow.loadURL(url)
  } catch (e) {
    console.error('Main: Failed to load scene:', e)
    sceneWindow.close()
    return null
  }

  // Create and initialize a controller for the scene
  const controllerType = controllerLoader.getControllerTypeForScene(sceneConfig)

  if (controllerType) {
    const controller = controllerLoader.createController(controllerType, sceneConfig)

    if (controller) {
      // Register the controller
      ipcManager.registerController(sceneName, controller)

      // Initialize the controller
      await controller.initialize(sceneWindow)

      // Set up window close event
      sceneWindow.on('close', async () => {
        await controller.dispose()
        ipcManager.unregisterController(sceneName)
      })
    }
  }

  sceneWindows.set(sceneName, sceneWindow)

  sceneWindow.on('closed', () => {
    sceneWindows.delete(sceneName)
    sceneConfigs.delete(sceneName)
  })

  return sceneWindow
}

function loadStoredScenes() {
  try {
    if (fs.existsSync(customScenesPath)) {
      const data = fs.readFileSync(customScenesPath, 'utf8')
      const scenes = JSON.parse(data)
      return scenes
    }
  } catch (error) {
    console.error('Main: Error loading stored scenes:', error)
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

// load controller files
function loadControllerFiles() {
  try {
    // Ensure the directory exists first
    const dirPath = path.dirname(controllerFilesPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log('Main: Created directory for controller files:', dirPath);
    }

    if (fs.existsSync(controllerFilesPath)) {
      const data = fs.readFileSync(controllerFilesPath, 'utf8');

      if (!data || data.trim() === '') {
        fs.writeFileSync(controllerFilesPath, '{}');
        return {};
      }

      try {
        const files = JSON.parse(data);

        // Validate paths on load
        const validatedFiles = {};
        for (const [sceneId, fileInfo] of Object.entries(files)) {
          if (!fileInfo || !fileInfo.path) {
            continue;
          }

          // Ensure path is absolute
          const filePath = path.isAbsolute(fileInfo.path)
            ? fileInfo.path
            : path.resolve(__dirname, fileInfo.path);

          // Check if file exists
          if (!fs.existsSync(filePath)) {
            console.warn(`Main: Controller file does not exist: ${filePath}`);
            continue;
          }

          // Include validated file
          validatedFiles[sceneId] = {
            name: fileInfo.name,
            path: filePath
          };
        }

        // If validation removed files, update storage
        if (Object.keys(validatedFiles).length !== Object.keys(files).length) {
          saveControllerFiles(validatedFiles);
        }

        return validatedFiles;
      } catch (parseError) {
        console.error('Main: Error parsing controller files data:', parseError);
        return {};
      }
    } else {
      fs.writeFileSync(controllerFilesPath, '{}');
      return {};
    }
  } catch (error) {
    console.error('Main: Error loading controller files:', error);
    // Try to create an empty file to fix possible permission issues
    try {
      // Ensure the directory exists
      const dirPath = path.dirname(controllerFilesPath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      fs.writeFileSync(controllerFilesPath, '{}');
    } catch (writeError) {
      console.error('Main: Failed to create controller files file:', writeError);
    }
  }
  return {};
}

// save controller files
function saveControllerFiles(files) {
  try {
    // First, validate all paths and normalize them
    const validatedFiles = {};
    for (const [sceneId, fileInfo] of Object.entries(files)) {
      if (!fileInfo || !fileInfo.path) {
        continue;
      }

      // Ensure path is absolute
      const filePath = path.isAbsolute(fileInfo.path)
        ? fileInfo.path
        : path.resolve(__dirname, fileInfo.path);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.warn(`Main: Controller file does not exist: ${filePath}`);
        continue;
      }

      // Include validated file
      validatedFiles[sceneId] = {
        name: fileInfo.name,
        path: filePath
      };
    }

    // Save only validated files
    const data = JSON.stringify(validatedFiles, null, 2);

    // Ensure the directory exists
    const dirPath = path.dirname(controllerFilesPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(controllerFilesPath, data);

    return true;
  } catch (error) {
    console.error('Main: Error saving controller files:', error);
    return false;
  }
}

// App initialization
app.whenReady().then(async () => {
  try {
    // initialize IPC handlers
    setupIpcHandlers();

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

function setupIpcHandlers() {

  ipcMain.on('open-scene', async (event, sceneName, sceneConfig, controllerFile) => {
    console.log('Main: Received open-scene request for:', sceneName)

    if (sceneConfig) {
      sceneConfigs.set(sceneName, sceneConfig)

      // Store custom scenes persistently
      if (sceneName.startsWith('gallery_custom_') ||
        sceneName.startsWith('physics_custom_') ||
        sceneName.startsWith('serial_custom_')) {
        const storedScenes = loadStoredScenes()
        storedScenes[sceneName] = {
          id: sceneName,
          config: sceneConfig
        }
        saveStoredScenes(storedScenes)
      }
    }

    // create scene window
    const sceneWindow = await createSceneWindow(sceneName, sceneConfig)

    // if there is a controller file, auto load
    if (controllerFile && sceneName.startsWith('serial_custom_')) {
      // if controller-loader is initialized, notify it to load the controller file
      if (sceneWindow && controllerFile.path) {
        // ensure path exists
        if (!fs.existsSync(controllerFile.path)) {
          console.error('Main: Controller file path does not exist:', controllerFile.path)
        } else {
          // wait for some time to ensure the window is fully initialized
          setTimeout(() => {
            sceneWindow.webContents.send('load-controller-file', {
              sceneName: sceneName,
              controllerPath: controllerFile.path
            })
          }, 1000)
        }
      }
    }
  })

  ipcMain.handle('get-scene-config', async (event) => {
    const windowId = event.sender.id

    for (const [sceneName, window] of sceneWindows.entries()) {
      if (window.webContents.id === windowId) {
        const config = sceneConfigs.get(sceneName)
        return { sceneName, config }
      }
    }

    return null
  })

  // store custom scene
  ipcMain.handle('store-custom-scene', async (event, sceneData) => {
    const storedScenes = loadStoredScenes()
    storedScenes[sceneData.id] = sceneData
    saveStoredScenes(storedScenes)
    return true
  })

  // get stored scenes
  ipcMain.handle('get-stored-scenes', async () => {
    return loadStoredScenes()
  })

  // delete stored scene
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

  ipcMain.handle('store-controller-files', async (event, controllerFiles) => {
    const success = saveControllerFiles(controllerFiles)
    return success
  })

  ipcMain.handle('get-controller-files', async () => {
    const files = loadControllerFiles()
    return files
  })

  // check if file exists
  ipcMain.handle('check-file-exists', async (event, filePath) => {
    try {
      const exists = fs.existsSync(filePath)
      return exists
    } catch (error) {
      console.error('Main: Error checking if file exists:', error)
      return false
    }
  })

  // Select controller file using dialog
  ipcMain.handle('select-controller-file', async (event) => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'JavaScript Files', extensions: ['js'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        title: 'Select Controller File'
      })

      if (result.canceled) {
        return null;
      }

      const filePath = result.filePaths[0];

      // Get file name from path
      const fileName = path.basename(filePath);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.warn('Main: Selected file does not exist:', filePath);
        return null;
      }

      // Return only serializable primitive data
      return {
        name: fileName,
        path: filePath
      };
    } catch (error) {
      console.error('Main: Error selecting controller file:', error);
      return null;
    }
  })

  // stop serial connection
  ipcMain.handle('stop-serial-connection', () => {
    console.log('Main: Stopping serial connection')
    // implement stop serial connection logic
    return true
  })

  console.log('IPC handlers setup complete')
}

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

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error)
})

if (isDevelopment) {
  app.commandLine.appendSwitch('ignore-certificate-errors')
}