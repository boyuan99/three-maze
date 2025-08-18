/**
 * ExperimentManager - Core system for dynamic experiment loading and IPC management
 * 
 * This class handles:
 * - Dynamic loading of experiment modules from filesystem
 * - Registration and cleanup of experiment-specific IPC handlers
 * - Error boundaries and experiment isolation
 * - Experiment lifecycle management
 */

import { pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';

export class ExperimentManager {
  constructor(mainWindow, ipcMain) {
    this.mainWindow = mainWindow;
    this.ipcMain = ipcMain;
    this.activeExperiment = null;
    this.registeredHandlers = new Map();
    this.coreHandlers = new Set([
      'load-experiment',
      'unload-experiment',
      'request-hardware',
      'release-hardware',
      'load-scene',
      'get-scene-status'
    ]);
    this.experimentInstances = new Map();
  }

  /**
   * Load an experiment module from filesystem
   * @param {string} experimentPath - Path to experiment file
   * @param {Object} config - Optional experiment configuration
   * @returns {Object} Result with success status and experiment details
   */
  async loadExperiment(experimentPath, config = {}) {
    try {
      // Unload current experiment first
      if (this.activeExperiment) {
        await this.unloadExperiment();
      }

      // Validate experiment file exists
      const absolutePath = path.resolve(experimentPath);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Experiment file not found: ${experimentPath}`);
      }

      // Validate file extension
      if (!absolutePath.endsWith('.js')) {
        throw new Error('Experiment files must have .js extension');
      }

      // Load experiment module dynamically
      const moduleUrl = pathToFileURL(absolutePath).href;
      
      // Add cache busting to ensure fresh load
      const cacheBustUrl = `${moduleUrl}?t=${Date.now()}`;
      
      let ExperimentClass;
      try {
        const module = await import(cacheBustUrl);
        ExperimentClass = module.default || module.ExperimentClass;
        
        if (!ExperimentClass) {
          throw new Error('Experiment module must export a default class or ExperimentClass');
        }
      } catch (importError) {
        throw new Error(`Failed to import experiment module: ${importError.message}`);
      }

      // Validate experiment class
      this.validateExperimentClass(ExperimentClass);

      // Create experiment instance
      const experimentInstance = new ExperimentClass(config);
      
      // Validate experiment instance
      this.validateExperimentInstance(experimentInstance);

      // Initialize experiment
      if (experimentInstance.initialize) {
        await experimentInstance.initialize();
      }

      // Register experiment handlers
      await this.registerExperimentHandlers(experimentInstance);

      // Store active experiment
      this.activeExperiment = {
        instance: experimentInstance,
        path: experimentPath,
        config: config,
        name: experimentInstance.name || path.basename(experimentPath, '.js'),
        version: experimentInstance.version || '1.0.0',
        loadTime: Date.now()
      };

      this.experimentInstances.set(this.activeExperiment.name, experimentInstance);

      return {
        success: true,
        experiment: {
          name: this.activeExperiment.name,
          version: this.activeExperiment.version,
          path: experimentPath,
          config: config,
          handlers: Array.from(this.registeredHandlers.keys())
        }
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.stack
      };
    }
  }

  /**
   * Unload current experiment and cleanup resources
   * @returns {Object} Result with success status
   */
  async unloadExperiment() {
    try {
      if (!this.activeExperiment) {
        return { success: true, message: 'No active experiment to unload' };
      }

      const experimentName = this.activeExperiment.name;

      // Cleanup experiment instance
      if (this.activeExperiment.instance.cleanup) {
        await this.activeExperiment.instance.cleanup();
      }

      // Unregister experiment handlers
      await this.unregisterExperimentHandlers();

      // Remove from instances map
      this.experimentInstances.delete(experimentName);

      // Clear active experiment
      this.activeExperiment = null;

      return {
        success: true,
        unloadedExperiment: experimentName
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get currently active experiment
   * @returns {Object|null} Active experiment details or null
   */
  getActiveExperiment() {
    return this.activeExperiment;
  }

  /**
   * Register experiment-specific IPC handlers
   * @param {Object} experimentInstance - Experiment instance
   */
  async registerExperimentHandlers(experimentInstance) {
    if (!experimentInstance.getIpcHandlers) {
      return; // No handlers to register
    }

    const handlers = experimentInstance.getIpcHandlers();
    
    for (const [handlerName, handlerFunc] of Object.entries(handlers)) {
      // Validate handler name doesn't conflict with core handlers
      if (this.coreHandlers.has(handlerName)) {
        throw new Error(`Handler name '${handlerName}' conflicts with core handler`);
      }

      // Validate handler is a function
      if (typeof handlerFunc !== 'function') {
        throw new Error(`Handler '${handlerName}' must be a function`);
      }

      // Check for conflicts with existing handlers
      if (this.registeredHandlers.has(handlerName)) {
        throw new Error(`Handler '${handlerName}' is already registered`);
      }

      // Wrap handler with error boundary
      const wrappedHandler = this.createErrorBoundaryHandler(handlerName, handlerFunc);

      // Register with IPC
      this.ipcMain.handle(handlerName, wrappedHandler);
      
      // Track registered handler
      this.registeredHandlers.set(handlerName, {
        original: handlerFunc,
        wrapped: wrappedHandler,
        experimentName: experimentInstance.name || 'unknown'
      });
    }
  }

  /**
   * Unregister all experiment handlers
   */
  async unregisterExperimentHandlers() {
    for (const handlerName of this.registeredHandlers.keys()) {
      // Remove IPC handler
      this.ipcMain.removeHandler(handlerName);
    }

    // Clear tracked handlers
    this.registeredHandlers.clear();
  }

  /**
   * Create error boundary wrapper for experiment handlers
   * @param {string} handlerName - Name of the handler
   * @param {Function} handlerFunc - Original handler function
   * @returns {Function} Wrapped handler with error boundary
   */
  createErrorBoundaryHandler(handlerName, handlerFunc) {
    return async (event, ...args) => {
      try {
        return await handlerFunc(event, ...args);
      } catch (error) {
        console.error(`Error in experiment handler '${handlerName}':`, error);
        
        // Return standardized error response
        return {
          success: false,
          error: `Handler '${handlerName}' failed: ${error.message}`,
          handlerName,
          timestamp: Date.now()
        };
      }
    };
  }

  /**
   * Validate experiment class before instantiation
   * @param {Function} ExperimentClass - Experiment class constructor
   */
  validateExperimentClass(ExperimentClass) {
    if (typeof ExperimentClass !== 'function') {
      throw new Error('Experiment must be a class constructor');
    }

    // Check if it's a proper class (has prototype)
    if (!ExperimentClass.prototype) {
      throw new Error('Experiment must be a valid class');
    }
  }

  /**
   * Validate experiment instance after instantiation
   * @param {Object} experimentInstance - Experiment instance
   */
  validateExperimentInstance(experimentInstance) {
    if (!experimentInstance || typeof experimentInstance !== 'object') {
      throw new Error('Experiment instance must be an object');
    }

    // Validate required properties
    const requiredMethods = ['cleanup'];
    for (const method of requiredMethods) {
      if (experimentInstance[method] && typeof experimentInstance[method] !== 'function') {
        throw new Error(`Experiment method '${method}' must be a function`);
      }
    }

    // Validate optional methods if present
    const optionalMethods = ['initialize', 'getIpcHandlers'];
    for (const method of optionalMethods) {
      if (experimentInstance[method] && typeof experimentInstance[method] !== 'function') {
        throw new Error(`Experiment method '${method}' must be a function`);
      }
    }
  }

  /**
   * Get list of registered handlers
   * @returns {Array} Array of handler names
   */
  getRegisteredHandlers() {
    return Array.from(this.registeredHandlers.keys());
  }

  /**
   * Get experiment status and statistics
   * @returns {Object} Experiment manager status
   */
  getStatus() {
    return {
      hasActiveExperiment: !!this.activeExperiment,
      activeExperiment: this.activeExperiment ? {
        name: this.activeExperiment.name,
        version: this.activeExperiment.version,
        path: this.activeExperiment.path,
        loadTime: this.activeExperiment.loadTime,
        uptime: this.activeExperiment.loadTime ? Date.now() - this.activeExperiment.loadTime : 0
      } : null,
      registeredHandlers: this.getRegisteredHandlers(),
      totalExperiments: this.experimentInstances.size
    };
  }

  /**
   * Force cleanup all resources (for emergency situations)
   */
  async forceCleanup() {
    try {
      // Unload active experiment
      if (this.activeExperiment) {
        await this.unloadExperiment();
      }

      // Clear all handlers
      await this.unregisterExperimentHandlers();

      // Clear instances
      this.experimentInstances.clear();

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}