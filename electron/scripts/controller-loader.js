// Responsible for loading and managing scene controllers

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { SerialHallwayController } from './controllers/serial-hallway-controller.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

class ControllerLoader {
  constructor() {
    this.controllers = new Map()
    this.controllerClasses = new Map()

    // Register built-in controller classes
    this.registerBuiltinControllers()
  }

  // Register built-in controller classes
  registerBuiltinControllers() {
    this.registerControllerClass('serial-hallway', SerialHallwayController)
  }

  // Register controller classes
  registerControllerClass(type, controllerClass) {
    this.controllerClasses.set(type, controllerClass)
    console.log(`Registered controller class: ${type}`)
  }

  // Load controller classes from external files
  async loadControllerClassFromFile(type, filePath) {
    try {
      // If it's a relative path, it's relative to the controllers directory
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(__dirname, 'controllers', filePath)
      }

      if (!fs.existsSync(filePath)) {
        console.error(`Controller file not found: ${filePath}`)
        return false
      }

      // Try to import the controller module
      const controllerModule = await import(filePath)

      // Find the first exported controller class (must inherit from SceneController)
      const exportedClass = Object.values(controllerModule).find(
        item => typeof item === 'function' && item.name.includes('Controller')
      )

      if (!exportedClass) {
        console.error(`No controller class found in ${filePath}`)
        return false
      }

      // Register controller class
      this.registerControllerClass(type, exportedClass)
      return true
    } catch (error) {
      console.error(`Failed to load controller class from ${filePath}:`, error)
      return false
    }
  }

  // Load custom controllers from the user directory
  async loadUserControllers(userDir) {
    try {
      if (!fs.existsSync(userDir)) {
        console.log(`User controller directory does not exist: ${userDir}`)
        return false
      }

      const files = fs.readdirSync(userDir)

      for (const file of files) {
        if (!file.endsWith('.js')) continue

        const filePath = path.join(userDir, file)
        const controllerType = path.basename(file, '.js')

        await this.loadControllerClassFromFile(controllerType, filePath)
      }

      return true
    } catch (error) {
      console.error(`Failed to load user controllers from ${userDir}:`, error)
      return false
    }
  }

  // Create a controller instance
  createController(type, options = {}) {
    const ControllerClass = this.controllerClasses.get(type)

    if (!ControllerClass) {
      console.error(`Controller class not found for type: ${type}`)
      return null
    }

    try {
      return new ControllerClass(options)
    } catch (error) {
      console.error(`Failed to create controller of type ${type}:`, error)
      return null
    }
  }

  // Get the controller type for the scene configuration
  getControllerTypeForScene(sceneConfig) {
    if (!sceneConfig) return null

    // Check if the scene configuration specifies a controller type
    if (sceneConfig.controllerType) {
      return sceneConfig.controllerType
    }

    // Infer the controller type based on the scene ID or other properties
    const sceneId = sceneConfig.id || ''

    if (sceneId.includes('serial_hallway') || sceneId.includes('serialhallway')) {
      return 'serial-hallway'
    }

    // Default to null, indicating no applicable controller
    return null
  }
}

export const controllerLoader = new ControllerLoader() 