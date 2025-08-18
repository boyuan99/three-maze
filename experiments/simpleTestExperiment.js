/**
 * Simple Test Experiment
 * A minimal experiment for testing the validation UI
 */

import { BaseExperiment } from '../src/experiments/BaseExperiment.js';

export default class SimpleTestExperiment extends BaseExperiment {
  constructor(userConfig = {}) {
    super({
      name: 'Simple Test Experiment',
      version: '1.0.0',
      description: 'A minimal experiment for testing validation and UI features',
      
      // Simple serial configuration
      serial: {
        port: userConfig.serialPort || 'COM3',
        baudRate: userConfig.serialBaudRate || 115200,
        initialization: userConfig.serialInit || 'TEST\\n'
      },
      
      // Simple data logging
      logging: {
        path: userConfig.logPath || './test-logs',
        format: userConfig.logFormat || 'csv',
        filename: userConfig.logFilename || `simple-test-${Date.now()}.csv`
      },
      
      // Simple IPC handler names
      ipcNames: {
        testStart: userConfig.startHandler || 'simple-test-start',
        testStop: userConfig.stopHandler || 'simple-test-stop',
        testStatus: userConfig.statusHandler || 'simple-test-status'
      },
      
      ...userConfig
    });
    
    // Test state
    this.testActive = false;
    this.testStartTime = null;
    this.dataCount = 0;
  }

  /**
   * Initialize the simple test experiment
   */
  async onInitialize() {
    console.log(`Starting ${this.name} v${this.version}`);
    console.log('Simple test configuration:', {
      serialPort: this.config.serial.port,
      logPath: this.config.logging.path,
      handlers: this.config.ipcNames
    });
    
    console.log('Simple test experiment initialized successfully');
  }

  /**
   * Start a simple test
   */
  async startSimpleTest() {
    if (this.testActive) {
      throw new Error('Test already running');
    }
    
    console.log('Starting simple test...');
    this.testActive = true;
    this.testStartTime = Date.now();
    this.dataCount = 0;
    
    // Simulate some test activity
    setTimeout(() => {
      if (this.testActive) {
        this.stopSimpleTest('completed');
      }
    }, 10000); // Stop after 10 seconds
    
    return { success: true, message: 'Simple test started' };
  }

  /**
   * Stop the simple test
   */
  async stopSimpleTest(reason = 'manual') {
    if (!this.testActive) {
      return { success: false, message: 'No test running' };
    }
    
    this.testActive = false;
    const duration = Date.now() - this.testStartTime;
    
    console.log(`Simple test stopped (${reason}) after ${duration}ms`);
    console.log(`Data points processed: ${this.dataCount}`);
    
    return { 
      success: true, 
      message: 'Simple test stopped',
      duration: duration,
      dataCount: this.dataCount
    };
  }

  /**
   * Get test status
   */
  getTestStatus() {
    return {
      active: this.testActive,
      startTime: this.testStartTime,
      duration: this.testActive ? Date.now() - this.testStartTime : 0,
      dataCount: this.dataCount
    };
  }

  /**
   * Custom IPC handlers for this simple test
   */
  getCustomHandlers() {
    return {
      [this.config.ipcNames.testStart]: async (event, testConfig = {}) => {
        try {
          return await this.startSimpleTest();
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      
      [this.config.ipcNames.testStop]: async (event) => {
        try {
          return await this.stopSimpleTest('manual');
        } catch (error) {
          return { success: false, error: error.message };
        }
      },
      
      [this.config.ipcNames.testStatus]: async (event) => {
        return this.getTestStatus();
      }
    };
  }

  /**
   * Cleanup when experiment is unloaded
   */
  async onCleanup() {
    console.log('Cleaning up simple test experiment...');
    
    if (this.testActive) {
      await this.stopSimpleTest('cleanup');
    }
    
    console.log('Simple test experiment cleaned up successfully');
  }
}

// Export configuration for the experiment loader
export const experimentConfig = {
  name: "Simple Test Experiment",
  version: "1.0.0",
  description: "A minimal experiment for testing validation and UI features",
  
  hardware: {
    required: [],
    optional: ["serial-port", "data-logging"]
  },
  
  // Default configuration
  defaultConfig: {
    serial: {
      port: 'COM3',
      baudRate: 115200
    },
    logging: {
      path: './test-logs',
      format: 'csv'
    }
  }
};