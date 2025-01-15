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
  
  startPythonSerial: () => ipcRenderer.invoke('start-python-serial'),
  stopPythonSerial: () => ipcRenderer.invoke('stop-python-serial'),
  onPythonSerialData: (callback) => {
    console.log('Setting up serial data listener')
    ipcRenderer.on('python-serial-data', (event, data) => {
      console.log('Preload received data:', data)
      callback(data)
    })
  },
  isSerialScene: (scenePath) => ipcRenderer.invoke('is-serial-scene', scenePath),
  onPythonError: (callback) => {
    ipcRenderer.on('python-error', (event, error) => callback(error))
  },
  sendToPython: (data) => {
    ipcRenderer.send('python-data', data)
  },
  onWindowClose: (callback) => ipcRenderer.on('window-close', callback),
  onPythonPositionData: (callback) => {ipcRenderer.on('python-position-data', (_, data) => callback(data))},
  initializeJsSerial: () => ipcRenderer.invoke('initialize-js-serial'),
  closeJsSerial: () => ipcRenderer.invoke('close-js-serial'),
  appendToLog: (data) => ipcRenderer.invoke('append-to-log', data),
  onSerialData: (callback) => ipcRenderer.on('serial-data', (event, data) => callback(data)),
  deliverWater: () => ipcRenderer.invoke('deliver-water'),
})

console.log('Preload: Script initialized')