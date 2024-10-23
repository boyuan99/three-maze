const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electron', {
  openScene: (sceneName) => ipcRenderer.send('open-scene', sceneName),
  sendMessage: (channel, data) => ipcRenderer.send(channel, data),
  onMessage: (channel, func) => {
    ipcRenderer.on(channel, (event, ...args) => func(...args))
  }
})