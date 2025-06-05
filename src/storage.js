// Store loaded scenes on the browser side

class StorageService {
  async storeScene(sceneData) {
    if (window.electron) {
      return await window.electron.storeCustomScene(sceneData)
    } else {
      try {
        const storedScenes = this.getStoredScenesSync()
        storedScenes[sceneData.id] = sceneData
        localStorage.setItem('customScenes', JSON.stringify(storedScenes))
        return true
      } catch (error) {
        console.error('Error storing scene in localStorage:', error)
        return false
      }
    }
  }

  async getStoredScenes() {
    if (window.electron) {
      return await window.electron.getStoredScenes()
    } else {
      return this.getStoredScenesSync()
    }
  }

  getStoredScenesSync() {
    try {
      const storedScenes = localStorage.getItem('customScenes')
      return storedScenes ? JSON.parse(storedScenes) : {}
    } catch (error) {
      console.error('Error reading from localStorage:', error)
      return {}
    }
  }

  async deleteScene(sceneId) {
    if (window.electron) {
      return await window.electron.deleteStoredScene(sceneId)
    } else {
      try {
        const storedScenes = this.getStoredScenesSync()
        delete storedScenes[sceneId]
        localStorage.setItem('customScenes', JSON.stringify(storedScenes))
        return true
      } catch (error) {
        console.error('Error deleting scene from localStorage:', error)
        return false
      }
    }
  }

  // Control file storage methods
  async storeControlFile(sceneId, controlFileData) {
    if (window.electron) {
      return await window.electron.storeControlFile(sceneId, controlFileData)
    } else {
      try {
        const storedControlFiles = this.getStoredControlFilesSync()
        storedControlFiles[sceneId] = controlFileData
        localStorage.setItem('controlFiles', JSON.stringify(storedControlFiles))
        return true
      } catch (error) {
        console.error('Error storing control file in localStorage:', error)
        return false
      }
    }
  }

  async getStoredControlFiles() {
    if (window.electron) {
      return await window.electron.getStoredControlFiles()
    } else {
      return this.getStoredControlFilesSync()
    }
  }

  getStoredControlFilesSync() {
    try {
      const storedControlFiles = localStorage.getItem('controlFiles')
      return storedControlFiles ? JSON.parse(storedControlFiles) : {}
    } catch (error) {
      console.error('Error reading control files from localStorage:', error)
      return {}
    }
  }

  async deleteControlFile(sceneId) {
    if (window.electron) {
      return await window.electron.deleteControlFile(sceneId)
    } else {
      try {
        const storedControlFiles = this.getStoredControlFilesSync()
        delete storedControlFiles[sceneId]
        localStorage.setItem('controlFiles', JSON.stringify(storedControlFiles))
        return true
      } catch (error) {
        console.error('Error deleting control file from localStorage:', error)
        return false
      }
    }
  }

  async getControlFile(sceneId) {
    const controlFiles = await this.getStoredControlFiles()
    return controlFiles[sceneId] || null
  }
}

export const storageService = new StorageService()