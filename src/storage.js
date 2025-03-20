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

  // save controller files
  async storeControllerFiles(controllerFiles) {
    if (window.electron) {
      try {
        // check if electron object has storeControllerFiles method
        if (typeof window.electron.storeControllerFiles === 'function') {
          // Sanitize data - ensure we only send serializable objects
          const sanitizedFiles = {};
          for (const [sceneId, fileInfo] of Object.entries(controllerFiles)) {
            if (fileInfo && typeof fileInfo === 'object') {
              sanitizedFiles[sceneId] = {
                name: fileInfo.name || '',
                path: fileInfo.path || ''
              };
            }
          }

          const result = await window.electron.storeControllerFiles(sanitizedFiles);
          return result;
        } else {
          console.warn('StorageService: electron.storeControllerFiles is not available');
          return false;
        }
      } catch (error) {
        console.error('StorageService: Error calling electron.storeControllerFiles:', error);
        return false;
      }
    } else {
      try {
        // Sanitize data for localStorage too
        const sanitizedFiles = {};
        for (const [sceneId, fileInfo] of Object.entries(controllerFiles)) {
          if (fileInfo && typeof fileInfo === 'object') {
            sanitizedFiles[sceneId] = {
              name: fileInfo.name || '',
              path: fileInfo.path || ''
            };
          }
        }

        localStorage.setItem('controllerFiles', JSON.stringify(sanitizedFiles));
        return true;
      } catch (error) {
        console.error('StorageService: Error storing controller files in localStorage:', error);
        return false;
      }
    }
  }

  // get controller files
  async getControllerFiles() {
    if (window.electron) {
      try {
        // check if electron object has getControllerFiles method
        if (typeof window.electron.getControllerFiles === 'function') {
          const files = await window.electron.getControllerFiles();
          return files;
        } else {
          console.warn('StorageService: electron.getControllerFiles is not available');
          return {};
        }
      } catch (error) {
        console.error('StorageService: Error calling electron.getControllerFiles:', error);
        return {};
      }
    } else {
      try {
        const controllerFiles = localStorage.getItem('controllerFiles');
        const files = controllerFiles ? JSON.parse(controllerFiles) : {};
        return files;
      } catch (error) {
        console.error('StorageService: Error reading controller files from localStorage:', error);
        return {};
      }
    }
  }
}

export const storageService = new StorageService()