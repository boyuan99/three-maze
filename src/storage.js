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
}

export const storageService = new StorageService()