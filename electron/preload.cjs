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
  
  listSerialPorts: () => ipcRenderer.invoke('list-serial-ports'),
  connectSerialPort: (path, options) => ipcRenderer.invoke('connect-serial-port', path, options),
  disconnectSerialPort: () => ipcRenderer.invoke('disconnect-serial-port'),
  onSerialData: (callback) => ipcRenderer.on('serial-data', callback)
})

console.log('Preload: Script initialized')