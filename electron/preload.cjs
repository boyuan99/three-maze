const {contextBridge, ipcRenderer} = require('electron')

console.log('Preload: Script starting')

contextBridge.exposeInMainWorld('electron', {
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
  
  startPythonSerial: (port, options) => ipcRenderer.invoke('start-python-serial', port, options),
  stopPythonSerial: () => ipcRenderer.invoke('stop-python-serial'),
  onPythonSerialData: (callback) => ipcRenderer.on('python-serial-data', (event, data) => callback(data)),
  isSerialScene: (scenePath) => ipcRenderer.invoke('is-serial-scene', scenePath),
  onPythonError: (callback) => ipcRenderer.on('python-error', (event, error) => callback(error)),
  sendToPython: (data) => ipcRenderer.send('python-data', data),
  onWindowClose: (callback) => ipcRenderer.on('window-close', callback)
})

console.log('Preload: Script initialized')