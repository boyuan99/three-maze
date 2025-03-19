// Scene controller base class, defining the interface of scene controllers

export class SceneController {
  constructor(options = {}) {
    this.options = options
    this.window = null
    this.isActive = false
  }

  // Initialize controller
  async initialize(window) {
    this.window = window
    this.isActive = true

    try {
      await this.onInitialize()
      return { success: true }
    } catch (error) {
      console.error(`Failed to initialize controller: ${error}`)
      return { success: false, error: error.message }
    }
  }

  // Frame update (called regularly by the main loop)
  async update() {
    if (!this.isActive || !this.window) return

    try {
      await this.onUpdate()
    } catch (error) {
      console.error(`Controller update error: ${error}`)
    }
  }

  // Close controller
  async dispose() {
    if (!this.isActive) return

    this.isActive = false

    try {
      await this.onDispose()
    } catch (error) {
      console.error(`Error disposing controller: ${error}`)
    }

    this.window = null
  }

  // Send messages to the scene window
  sendToScene(channel, ...args) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args)
    }
  }

  // Set IPC listeners (called by IpcManager when registering controllers)
  setupIpc(ipcMain, ipcManager) {
    // Subclasses can override this method to set custom IPC listeners
  }

  // Clean up IPC listeners (called by IpcManager when unloading controllers)
  cleanupIpc(ipcMain, ipcManager) {
    // Subclasses can override this method to clean up custom IPC listeners
  }

  // The following methods should be implemented by subclasses

  // Initialize hook (called when the controller is initialized)
  async onInitialize() {
    // Implement by subclasses
  }

  // Update hook (called every frame)
  async onUpdate() {
    // Implement by subclasses
  }

  // Dispose hook (called when the controller is disposed)
  async onDispose() {
    // Implement by subclasses
  }
} 