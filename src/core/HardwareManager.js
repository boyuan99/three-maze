/**
 * HardwareManager - Core system for hardware resource allocation and management
 * 
 * This class handles:
 * - Exclusive access control for hardware resources
 * - Resource lifecycle management and cleanup
 * - Hardware abstraction and device initialization
 * - Conflict detection and resolution
 */

import { SerialPort } from 'serialport';
import { spawn } from 'child_process';
import path from 'path';

export class HardwareManager {
  constructor() {
    this.resources = new Map();
    this.resourceOwnership = new Map();
    this.exclusiveResources = new Set(['serial-port', 'water-delivery', 'python-backend']);
    this.resourceInitializers = new Map([
      ['serial-port', this.initializeSerialPort.bind(this)],
      ['water-delivery', this.initializeWaterDelivery.bind(this)],
      ['python-backend', this.initializePythonBackend.bind(this)],
      ['data-logging', this.initializeDataLogging.bind(this)]
    ]);
  }

  /**
   * Request a hardware resource with exclusive access control
   * @param {string} resourceType - Type of resource to request
   * @param {Object} config - Resource configuration
   * @param {string} experimentId - ID of requesting experiment
   * @returns {string} Resource handle for managing the resource
   */
  async requestResource(resourceType, config = {}, experimentId = 'default') {
    try {
      // Validate resource type
      if (!this.resourceInitializers.has(resourceType)) {
        throw new Error(`Unsupported resource type: ${resourceType}`);
      }

      // Check for exclusive access conflicts
      if (this.exclusiveResources.has(resourceType)) {
        const existingOwner = this.findResourceOwner(resourceType);
        if (existingOwner && existingOwner !== experimentId) {
          throw new Error(`Resource '${resourceType}' is already in use by experiment '${existingOwner}'`);
        }
      }

      // Generate unique handle
      const handle = this.generateResourceHandle(resourceType);

      // Initialize resource
      const initializer = this.resourceInitializers.get(resourceType);
      const resourceInstance = await initializer(config, handle);

      // Store resource
      this.resources.set(handle, {
        type: resourceType,
        instance: resourceInstance,
        config: config,
        experimentId: experimentId,
        createdAt: Date.now(),
        status: 'active'
      });

      // Track ownership
      if (!this.resourceOwnership.has(experimentId)) {
        this.resourceOwnership.set(experimentId, new Set());
      }
      this.resourceOwnership.get(experimentId).add(handle);

      return handle;

    } catch (error) {
      throw new Error(`Failed to request resource '${resourceType}': ${error.message}`);
    }
  }

  /**
   * Release a specific hardware resource
   * @param {string} handle - Resource handle to release
   * @returns {boolean} Success status
   */
  async releaseResource(handle) {
    try {
      const resource = this.resources.get(handle);
      if (!resource) {
        throw new Error(`Invalid resource handle: ${handle}`);
      }

      // Cleanup resource instance
      if (resource.instance && resource.instance.cleanup) {
        await resource.instance.cleanup();
      }

      // Remove from ownership tracking
      const experimentId = resource.experimentId;
      if (this.resourceOwnership.has(experimentId)) {
        this.resourceOwnership.get(experimentId).delete(handle);
        
        // Clean up empty ownership entry
        if (this.resourceOwnership.get(experimentId).size === 0) {
          this.resourceOwnership.delete(experimentId);
        }
      }

      // Remove resource
      this.resources.delete(handle);

      return true;

    } catch (error) {
      throw new Error(`Failed to release resource: ${error.message}`);
    }
  }

  /**
   * Force release all resources for a specific experiment
   * @param {string} experimentId - Experiment ID ('all' for all experiments)
   * @returns {Object} Release results
   */
  async forceReleaseAll(experimentId) {
    const releasedHandles = [];
    const failedReleases = [];

    try {
      const handlesToRelease = [];

      if (experimentId === 'all') {
        handlesToRelease.push(...this.resources.keys());
      } else {
        const experimentHandles = this.resourceOwnership.get(experimentId);
        if (experimentHandles) {
          handlesToRelease.push(...experimentHandles);
        }
      }

      for (const handle of handlesToRelease) {
        try {
          await this.releaseResource(handle);
          releasedHandles.push(handle);
        } catch (error) {
          failedReleases.push({ handle, error: error.message });
        }
      }

      return {
        success: failedReleases.length === 0,
        released: releasedHandles.length,
        failed: failedReleases.length,
        details: {
          releasedHandles,
          failedReleases
        }
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        released: releasedHandles.length,
        failed: failedReleases.length
      };
    }
  }

  /**
   * Get resource instance by handle
   * @param {string} handle - Resource handle
   * @returns {Object|null} Resource instance or null if not found
   */
  getResource(handle) {
    const resource = this.resources.get(handle);
    return resource ? resource.instance : null;
  }

  /**
   * Get all resources owned by an experiment
   * @param {string} experimentId - Experiment ID
   * @returns {Array} Array of resource handles
   */
  getExperimentResources(experimentId) {
    const handles = this.resourceOwnership.get(experimentId);
    return handles ? Array.from(handles) : [];
  }

  /**
   * Get hardware manager status and statistics
   * @returns {Object} Status information
   */
  getStatus() {
    const resourcesByType = new Map();
    const resourcesByExperiment = new Map();

    for (const [handle, resource] of this.resources) {
      // Count by type
      if (!resourcesByType.has(resource.type)) {
        resourcesByType.set(resource.type, 0);
      }
      resourcesByType.set(resource.type, resourcesByType.get(resource.type) + 1);

      // Count by experiment
      if (!resourcesByExperiment.has(resource.experimentId)) {
        resourcesByExperiment.set(resource.experimentId, 0);
      }
      resourcesByExperiment.set(resource.experimentId, resourcesByExperiment.get(resource.experimentId) + 1);
    }

    return {
      totalResources: this.resources.size,
      activeExperiments: this.resourceOwnership.size,
      resourcesByType: Object.fromEntries(resourcesByType),
      resourcesByExperiment: Object.fromEntries(resourcesByExperiment),
      supportedTypes: Array.from(this.resourceInitializers.keys())
    };
  }

  /**
   * Initialize serial port resource
   * @param {Object} config - Serial port configuration
   * @param {string} handle - Resource handle
   * @returns {Object} Serial port wrapper
   */
  async initializeSerialPort(config, handle) {
    const defaultConfig = {
      port: 'COM3',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    };

    const serialConfig = { ...defaultConfig, ...config };

    try {
      const serialPort = new SerialPort({
        path: serialConfig.port,
        baudRate: serialConfig.baudRate,
        dataBits: serialConfig.dataBits,
        stopBits: serialConfig.stopBits,
        parity: serialConfig.parity,
        autoOpen: false
      });

      // Wrap with resource management
      const serialWrapper = {
        port: serialPort,
        handle: handle,
        config: serialConfig,
        isOpen: false,
        
        async open() {
          return new Promise((resolve, reject) => {
            serialPort.open((error) => {
              if (error) {
                reject(new Error(`Failed to open serial port: ${error.message}`));
              } else {
                this.isOpen = true;
                resolve(true);
              }
            });
          });
        },

        async close() {
          if (!this.isOpen) return true;
          
          return new Promise((resolve, reject) => {
            serialPort.close((error) => {
              if (error) {
                reject(new Error(`Failed to close serial port: ${error.message}`));
              } else {
                this.isOpen = false;
                resolve(true);
              }
            });
          });
        },

        write(data) {
          return new Promise((resolve, reject) => {
            if (!this.isOpen) {
              reject(new Error('Serial port is not open'));
              return;
            }

            serialPort.write(data, (error) => {
              if (error) {
                reject(new Error(`Failed to write to serial port: ${error.message}`));
              } else {
                resolve(true);
              }
            });
          });
        },

        on(event, callback) {
          serialPort.on(event, callback);
        },

        async cleanup() {
          await this.close();
        }
      };

      // Auto-open if requested
      if (serialConfig.autoOpen !== false) {
        await serialWrapper.open();
      }

      return serialWrapper;

    } catch (error) {
      throw new Error(`Serial port initialization failed: ${error.message}`);
    }
  }

  /**
   * Initialize water delivery system resource
   * @param {Object} config - Water delivery configuration
   * @param {string} handle - Resource handle
   * @returns {Object} Water delivery wrapper
   */
  async initializeWaterDelivery(config, handle) {
    const defaultConfig = {
      hardware: 'python-script',
      cooldownMs: 1000,
      deliveryDurationMs: 100,
      maxDeliveriesPerMinute: 60,
      testMode: false
    };

    const waterConfig = { ...defaultConfig, ...config };

    try {
      let pythonProcess = null;

      const waterWrapper = {
        handle: handle,
        config: waterConfig,
        isRunning: false,
        deliveryCount: 0,
        lastDeliveryTime: 0,

        async start() {
          if (waterConfig.hardware === 'python-script') {
            const scriptPath = path.join(process.cwd(), 'electron', 'scripts', 'water_delivery.py');
            pythonProcess = spawn('python', [scriptPath], {
              stdio: ['pipe', 'pipe', 'pipe']
            });

            pythonProcess.on('error', (error) => {
              throw new Error(`Python process error: ${error.message}`);
            });
          }

          this.isRunning = true;
        },

        async stop() {
          if (pythonProcess) {
            pythonProcess.kill();
            pythonProcess = null;
          }
          this.isRunning = false;
        },

        async deliverWater(amount = 1) {
          if (!this.isRunning) {
            throw new Error('Water delivery system not running');
          }

          const now = Date.now();

          // Check cooldown
          if (now - this.lastDeliveryTime < waterConfig.cooldownMs) {
            throw new Error(`Cooldown active: wait ${waterConfig.cooldownMs - (now - this.lastDeliveryTime)}ms`);
          }

          // Check rate limit
          const deliveriesThisMinute = this.getDeliveriesInLastMinute();
          if (deliveriesThisMinute >= waterConfig.maxDeliveriesPerMinute) {
            throw new Error('Maximum deliveries per minute exceeded');
          }

          // Simulate delivery
          if (waterConfig.testMode) {
            await new Promise(resolve => setTimeout(resolve, waterConfig.deliveryDurationMs));
          } else if (pythonProcess) {
            // Send command to Python script
            pythonProcess.stdin.write(`deliver:${amount}\n`);
            await new Promise(resolve => setTimeout(resolve, waterConfig.deliveryDurationMs));
          }

          this.deliveryCount++;
          this.lastDeliveryTime = now;

          return {
            success: true,
            amount: amount,
            timestamp: now,
            duration: waterConfig.deliveryDurationMs,
            totalDeliveries: this.deliveryCount
          };
        },

        getDeliveriesInLastMinute() {
          // Simplified implementation for testing
          return Math.min(this.deliveryCount, 10);
        },

        async cleanup() {
          await this.stop();
        }
      };

      await waterWrapper.start();
      return waterWrapper;

    } catch (error) {
      throw new Error(`Water delivery initialization failed: ${error.message}`);
    }
  }

  /**
   * Initialize Python backend resource
   * @param {Object} config - Python backend configuration
   * @param {string} handle - Resource handle
   * @returns {Object} Python backend wrapper
   */
  async initializePythonBackend(config, handle) {
    const defaultConfig = {
      scriptPath: 'control/hallway/__main__.py',
      port: 8765,
      timeout: 5000
    };

    const pythonConfig = { ...defaultConfig, ...config };

    try {
      const pythonWrapper = {
        handle: handle,
        config: pythonConfig,
        process: null,
        isRunning: false,

        async start() {
          const scriptPath = path.join(process.cwd(), pythonConfig.scriptPath);
          this.process = spawn('python', ['-m', scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: process.cwd()
          });

          this.process.on('error', (error) => {
            this.isRunning = false;
            throw new Error(`Python backend error: ${error.message}`);
          });

          // Wait for startup
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Python backend startup timeout'));
            }, pythonConfig.timeout);

            this.process.stdout.on('data', (data) => {
              if (data.toString().includes('started')) {
                clearTimeout(timeout);
                this.isRunning = true;
                resolve();
              }
            });
          });
        },

        async stop() {
          if (this.process) {
            this.process.kill();
            this.process = null;
          }
          this.isRunning = false;
        },

        async cleanup() {
          await this.stop();
        }
      };

      await pythonWrapper.start();
      return pythonWrapper;

    } catch (error) {
      throw new Error(`Python backend initialization failed: ${error.message}`);
    }
  }

  /**
   * Initialize data logging resource
   * @param {Object} config - Data logging configuration
   * @param {string} handle - Resource handle
   * @returns {Object} Data logging wrapper
   */
  async initializeDataLogging(config, handle) {
    const defaultConfig = {
      logPath: 'logs',
      format: 'csv',
      rotation: 'daily',
      compression: false
    };

    const loggingConfig = { ...defaultConfig, ...config };

    try {
      const loggingWrapper = {
        handle: handle,
        config: loggingConfig,
        isActive: false,
        logFiles: new Map(),

        async start() {
          this.isActive = true;
        },

        async stop() {
          this.isActive = false;
          this.logFiles.clear();
        },

        async log(category, data) {
          if (!this.isActive) {
            throw new Error('Data logging not active');
          }

          // Simplified logging implementation
          console.log(`[${category}] ${JSON.stringify(data)}`);
          return true;
        },

        async cleanup() {
          await this.stop();
        }
      };

      await loggingWrapper.start();
      return loggingWrapper;

    } catch (error) {
      throw new Error(`Data logging initialization failed: ${error.message}`);
    }
  }

  /**
   * Generate unique resource handle
   * @param {string} resourceType - Type of resource
   * @returns {string} Unique handle
   */
  generateResourceHandle(resourceType) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `${resourceType}-${timestamp}-${random}`;
  }

  /**
   * Find which experiment owns a resource type
   * @param {string} resourceType - Type of resource
   * @returns {string|null} Experiment ID or null if not found
   */
  findResourceOwner(resourceType) {
    for (const [handle, resource] of this.resources) {
      if (resource.type === resourceType) {
        return resource.experimentId;
      }
    }
    return null;
  }
}