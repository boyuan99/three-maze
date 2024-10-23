import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Store window references
let mainWindow = null
const sceneWindows = new Map()

function createMainWindow() {
  // Create the main window
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    frame: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs')
    },
    backgroundColor: '#1a1a1a'
  })

  // Remove window frame and menu
  mainWindow.setMenuBarVisibility(false)
  mainWindow.setTitle('')

  // Load the app
  const devServerUrl = 'http://localhost:5173'

  if (process.env.NODE_ENV === 'development') {
    // In development, load from Vite dev server
    console.log('Loading from dev server:', devServerUrl)
    mainWindow.loadURL(devServerUrl)

    // Optional: Open DevTools in development
    mainWindow.webContents.openDevTools()
  } else {
    // In production, load from built files
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Handle keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      app.quit()
    }
  })

  return mainWindow
}

function createSceneWindow(sceneName) {
  // Check if window already exists
  if (sceneWindows.has(sceneName)) {
    const existingWindow = sceneWindows.get(sceneName)
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.focus()
      return existingWindow
    }
  }

  // Create new scene window
  const sceneWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    frame: false,
    fullscreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.cjs')
    },
    backgroundColor: '#1a1a1a'
  })

  // Remove window frame and menu
  sceneWindow.setMenuBarVisibility(false)
  sceneWindow.setTitle('')

  // Load scene content
  const url = process.env.NODE_ENV === 'development'
    ? `http://localhost:5173/#/scene/${sceneName}`
    : `file://${join(__dirname, '../dist/index.html')}#/scene/${sceneName}`

  console.log('Loading scene URL:', url)
  sceneWindow.loadURL(url)

  // Store window reference
  sceneWindows.set(sceneName, sceneWindow)

  // Handle window close
  sceneWindow.on('closed', () => {
    sceneWindows.delete(sceneName)
  })

  // Handle keyboard shortcuts
  sceneWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      sceneWindow.close()
    }
  })

  // Optional: Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    sceneWindow.webContents.openDevTools()
  }

  return sceneWindow
}

// App event handlers
app.whenReady().then(() => {
  createMainWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow()
  }
})

// IPC handlers
ipcMain.on('open-scene', (event, sceneName) => {
  console.log('Opening scene:', sceneName)
  createSceneWindow(sceneName)
})

// Development error handling
if (process.env.NODE_ENV === 'development') {
  app.on('render-process-gone', (event, webContents, details) => {
    console.error('Render process gone:', details)
  })

  app.on('child-process-gone', (event, details) => {
    console.error('Child process gone:', details)
  })
}

// Security features
app.on('web-contents-created', (event, contents) => {
  // Prevent navigation to external URLs
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl)
    if (process.env.NODE_ENV !== 'development') {
      event.preventDefault()
    }
  })

  // Prevent new window creation
  contents.setWindowOpenHandler(({ url }) => {
    return { action: 'deny' }
  })
})

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error)
})

// Development specific settings
if (process.env.NODE_ENV === 'development') {
  app.commandLine.appendSwitch('ignore-certificate-errors')
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}