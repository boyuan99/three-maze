import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const isDevelopment = process.env.NODE_ENV === 'development'
const VITE_DEV_SERVER_URL = 'http://localhost:5173'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let mainWindow = null
const sceneWindows = new Map()

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    frame: false,
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
      // mainWindow.webContents.openDevTools()
    } else {
      const indexHtml = join(__dirname, '../dist/index.html')
      console.log('Loading production file:', indexHtml)
      await mainWindow.loadFile(indexHtml)
    }
  } catch (e) {
    console.error('Failed to load main window:', e)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      app.quit()
    }
  })

  return mainWindow
}

async function createSceneWindow(sceneName) {
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
    backgroundColor: '#1a1a1a'
  })

  sceneWindow.setMenuBarVisibility(false)

  sceneWindow.once('ready-to-show', () => {
    sceneWindow.show()
  })

  try {
    const url = isDevelopment
      ? `${VITE_DEV_SERVER_URL}/#/scene/${sceneName}`
      : `file://${join(__dirname, '../dist/index.html')}#/scene/${sceneName}`

    console.log('Loading scene URL:', url)
    await sceneWindow.loadURL(url)

    // if (isDevelopment) {
    //   sceneWindow.webContents.openDevTools()
    // }
  } catch (e) {
    console.error('Failed to load scene:', e)
    sceneWindow.close()
    return null
  }

  sceneWindows.set(sceneName, sceneWindow)

  sceneWindow.on('closed', () => {
    sceneWindows.delete(sceneName)
  })

  sceneWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      sceneWindow.close()
    }
  })

  return sceneWindow
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
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', async () => {
  if (mainWindow === null) {
    await createMainWindow()
  }
})

// IPC handlers
ipcMain.on('open-scene', async (event, sceneName) => {
  console.log('Opening scene:', sceneName)
  await createSceneWindow(sceneName)
})

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error)
})

// Development specific
if (isDevelopment) {
  app.commandLine.appendSwitch('ignore-certificate-errors')
}