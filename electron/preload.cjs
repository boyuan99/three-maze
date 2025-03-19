const { contextBridge, ipcRenderer } = require('electron')

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

  getDisplays: () => ipcRenderer.invoke('get-displays'),
  setPreferredDisplay: (displayId) => ipcRenderer.send('set-preferred-display', displayId),
  getPreferredDisplay: () => ipcRenderer.invoke('get-preferred-display'),
  onDisplayChanged: (callback) => {
    ipcRenderer.on('display-changed', (_, displayId) => callback(displayId))
  },

  controller: {
    onControllerReady: (callback) => ipcRenderer.on('controller-ready', (_, data) => callback(data)),
    on: (channel, callback) => ipcRenderer.on(channel, (_, ...args) => callback(...args)),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),

    resetPosition: () => ipcRenderer.invoke('reset-position'),
    onPositionUpdate: (callback) => ipcRenderer.on('position-update', (_, data) => callback(data)),
    onPositionReset: (callback) => ipcRenderer.on('position-reset', (_, data) => callback(data)),

    deliverReward: () => ipcRenderer.invoke('deliver-reward'),
    onRewardDelivered: (callback) => ipcRenderer.on('reward-delivered', (_, data) => callback(data)),

    getDataLog: () => ipcRenderer.invoke('get-data-log'),
    appendToLog: (data) => ipcRenderer.invoke('append-to-log', data),

    initializeSerial: () => ipcRenderer.invoke('initialize-js-serial'),
    closeSerial: () => ipcRenderer.invoke('close-js-serial'),
    onSerialData: (callback) => ipcRenderer.on('serial-data', (_, data) => callback(data)),
    onSerialRawData: (callback) => ipcRenderer.on('serial-raw-data', (_, data) => callback(data)),
    onSerialError: (callback) => ipcRenderer.on('serial-error', (_, data) => callback(data)),

    startPythonSerial: () => ipcRenderer.invoke('start-python-serial'),
    stopPythonSerial: () => ipcRenderer.invoke('stop-python-serial'),
    onPythonData: (callback) => ipcRenderer.on('python-data', (_, data) => callback(data)),
    onPythonOutput: (callback) => ipcRenderer.on('python-output', (_, data) => callback(data)),
    onPythonError: (callback) => ipcRenderer.on('python-error', (_, error) => callback(error)),
    onPythonExit: (callback) => ipcRenderer.on('python-exit', (_, data) => callback(data)),
    onPythonSerialData: (callback) => {
      console.log('Setting up python serial data listener')
      ipcRenderer.on('python-serial-data', (_, data) => {
        console.log('Preload received python data:', data)
        callback(data)
      })
    },
    sendToPython: (data) => ipcRenderer.send('python-data', data)
  },

  deliverWater: function () { return this.controller.deliverReward() },
  initializeJsSerial: function () { return this.controller.initializeSerial() },
  closeJsSerial: function () { return this.controller.closeSerial() },
  appendToLog: function (data) { return this.controller.appendToLog(data) },
  onSerialData: function (callback) { this.controller.onSerialData(callback) },
  startPythonSerial: function () { return this.controller.startPythonSerial() },
  stopPythonSerial: function () { return this.controller.stopPythonSerial() },
  onPythonSerialData: function (callback) { this.controller.onPythonSerialData(callback) },
  onPythonError: function (callback) { this.controller.onPythonError(callback) },
  sendToPython: function (data) { this.controller.sendToPython(data) },
  onWindowClose: (callback) => ipcRenderer.on('window-close', callback),
  onPythonPositionData: (callback) => { ipcRenderer.on('python-position-data', (_, data) => callback(data)) },
  isSerialScene: (scenePath) => ipcRenderer.invoke('is-serial-scene', scenePath)
})

console.log('Preload: Script initialized')