const { contextBridge, ipcRenderer } = require('electron')

console.log('Preload: Script starting')

contextBridge.exposeInMainWorld('electron', {
  // Generic dynamic IPC bridge for user-defined experiment handlers
  invoke: (handlerName, ...args) => {
    console.log('Preload: Invoking dynamic handler:', handlerName)
    return ipcRenderer.invoke(handlerName, ...args)
  },
  
  // Core experiment management (always available)
  loadExperiment: (experimentPath, config) => ipcRenderer.invoke('load-experiment', experimentPath, config),
  unloadExperiment: () => ipcRenderer.invoke('unload-experiment'),
  getActiveExperiment: () => ipcRenderer.invoke('get-active-experiment'),
  validateExperiment: (experimentPath) => ipcRenderer.invoke('validate-experiment', experimentPath),
  requestHardware: (type, config) => ipcRenderer.invoke('request-hardware', type, config),
  releaseHardware: (handle) => ipcRenderer.invoke('release-hardware', handle),
  listHardware: () => ipcRenderer.invoke('list-hardware'),
  hardwareStatus: () => ipcRenderer.invoke('hardware-status'),
  
  openScene: (sceneName, sceneConfig) => {
    console.log('Preload: Opening scene:', sceneName)
    console.log('Preload: With config:', sceneConfig)
    ipcRenderer.send('open-scene', sceneName, sceneConfig)
  },
  sendMessage: (channel, data) => {
    console.log('Preload: Sending message on channel:', channel)
    ipcRenderer.send(channel, data)
  },
  onMessage: (channel, func) => {
    console.log('Preload: Setting up listener for channel:', channel)
    ipcRenderer.on(channel, (event, ...args) => func(...args))
  },
  getSceneConfig: () => {
    console.log('Preload: Requesting scene config')
    return ipcRenderer.invoke('get-scene-config')
  },
  storeCustomScene: (sceneData) => ipcRenderer.invoke('store-custom-scene', sceneData),
  getStoredScenes: () => ipcRenderer.invoke('get-stored-scenes'),
  deleteStoredScene: (sceneId) => ipcRenderer.invoke('delete-stored-scene', sceneId),

  // Control file management
  storeControlFile: (sceneId, controlFileData) => ipcRenderer.invoke('store-control-file', sceneId, controlFileData),
  getStoredControlFiles: () => ipcRenderer.invoke('get-stored-control-files'),
  deleteControlFile: (sceneId) => ipcRenderer.invoke('delete-control-file', sceneId),

  startPythonSerial: () => ipcRenderer.invoke('start-python-serial'),
  stopPythonSerial: () => ipcRenderer.invoke('stop-python-serial'),
  onPythonSerialData: (callback) => {
    console.log('Setting up serial data listener')
    ipcRenderer.on('python-serial-data', (event, data) => {
      console.log('Preload received data:', data)
      callback(data)
    })
  },
  // Keep only the Python handlers that are actually used
  onPythonError: (callback) => {
    ipcRenderer.on('python-error', (event, error) => callback(error))
  },
  sendToPython: (data) => {
    ipcRenderer.send('python-data', data)
  },
  // Legacy serial handlers removed - use requestHardware('serial-port') instead
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  setPreferredDisplay: (displayId) => ipcRenderer.send('set-preferred-display', displayId),
  getPreferredDisplay: () => ipcRenderer.invoke('get-preferred-display'),
  onDisplayChanged: (callback) => {
    ipcRenderer.on('display-changed', (_, displayId) => callback(displayId))
  }
})

console.log('Preload: Script initialized')