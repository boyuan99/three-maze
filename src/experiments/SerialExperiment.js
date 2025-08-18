/**
 * SerialExperiment - Base class for experiments requiring serial communication
 * 
 * This class provides:
 * - Serial port connection management and configuration
 * - Data parsing for 13-value CSV format from hardware
 * - Event handling for data reception and errors
 * - Buffer management for partial data and line processing
 * - Command sending capabilities
 */

export class SerialExperiment {
  constructor(config = {}) {
    this.config = config;
    this.serialHandle = null;
    this.serialWrapper = null;
    this.dataHandlers = [];
    this.connectionState = 'disconnected';
    this.lastDataReceived = null;
    this.dataBuffer = '';
    this.parseErrors = [];
    this.isInitialized = false;
  }

  /**
   * Initialize serial communication with hardware
   * @param {Object} config - Serial configuration options
   * @returns {Object} Serial port wrapper instance
   */
  async initializeSerial(config = {}) {
    const defaultConfig = {
      port: 'COM3',
      baudRate: 115200,
      parser: 'line',
      initialization: '10000,50,10,1\n',
      timeout: 5000,
      autoOpen: true
    };

    const serialConfig = { ...defaultConfig, ...this.config, ...config };
    
    try {
      // Request serial hardware from hardware manager
      // This would typically be injected or obtained from the system
      this.serialWrapper = await this.requestSerialHardware(serialConfig);
      
      // Set up event handlers
      this.setupSerialEventHandlers();

      // Send initialization string if specified
      if (serialConfig.initialization && serialConfig.initialization.trim()) {
        await this.sendSerialCommand(serialConfig.initialization);
      }

      this.isInitialized = true;
      return this.serialWrapper;

    } catch (error) {
      this.connectionState = 'error';
      throw new Error(`Failed to initialize serial port: ${error.message}`);
    }
  }

  /**
   * Set up serial event handlers for data, errors, and connection state
   */
  setupSerialEventHandlers() {
    if (!this.serialWrapper || !this.serialWrapper.port) {
      return;
    }

    // Data reception handler
    this.serialWrapper.port.on('data', (data) => {
      this.handleRawData(data);
    });

    // Error handler
    this.serialWrapper.port.on('error', (error) => {
      this.connectionState = 'error';
      console.error('Serial port error:', error);
    });

    // Connection state handlers
    this.serialWrapper.port.on('open', () => {
      this.connectionState = 'connected';
    });

    this.serialWrapper.port.on('close', () => {
      this.connectionState = 'disconnected';
    });
  }

  /**
   * Handle incoming raw data from serial port
   * @param {Buffer} data - Raw data buffer from serial port
   */
  handleRawData(data) {
    try {
      const dataString = data.toString();
      this.dataBuffer += dataString;

      // Process complete lines
      const lines = this.dataBuffer.split('\n');
      this.dataBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          try {
            const parsedData = this.parseSerialData(trimmedLine);
            this.lastDataReceived = parsedData;
            
            // Notify all data handlers
            this.notifyDataHandlers(parsedData);
          } catch (parseError) {
            this.recordParseError(parseError, trimmedLine);
          }
        }
      }
    } catch (error) {
      this.recordParseError(error, data.toString());
    }
  }

  /**
   * Parse serial data from 13-value CSV format
   * Expected format: timestamp,dx1,dy1,dt1,dx2,dy2,dt2,x,y,theta,water,direction,frameCount
   * @param {string} rawData - Raw CSV data string
   * @returns {Object} Parsed data object
   */
  parseSerialData(rawData) {
    const values = rawData.split(',');
    
    if (values.length < 13) {
      throw new Error(`Invalid serial data format: expected 13 values, got ${values.length}`);
    }

    try {
      const parsedData = {
        timestamp: values[0],
        leftSensor: {
          dx: parseFloat(values[1]),
          dy: parseFloat(values[2]),
          dt: parseFloat(values[3])
        },
        rightSensor: {
          dx: parseFloat(values[4]),
          dy: parseFloat(values[5]),
          dt: parseFloat(values[6])
        },
        x: parseFloat(values[7]),
        y: parseFloat(values[8]),
        theta: parseFloat(values[9]),
        water: parseInt(values[10]),
        direction: parseFloat(values[11]),
        frameCount: parseInt(values[12]),
        raw: rawData,
        parsedAt: Date.now()
      };

      // Validate parsed numbers
      this.validateParsedData(parsedData);
      
      return parsedData;
    } catch (error) {
      throw new Error(`Failed to parse serial data: ${error.message}`);
    }
  }

  /**
   * Validate parsed serial data for NaN values and ranges
   * @param {Object} data - Parsed data object
   */
  validateParsedData(data) {
    const numericFields = [
      'leftSensor.dx', 'leftSensor.dy', 'leftSensor.dt',
      'rightSensor.dx', 'rightSensor.dy', 'rightSensor.dt',
      'x', 'y', 'theta', 'direction'
    ];

    for (const field of numericFields) {
      const value = this.getNestedValue(data, field);
      if (isNaN(value)) {
        throw new Error(`Invalid numeric value for field '${field}': ${value}`);
      }
    }

    // Validate integer fields
    if (isNaN(data.water) || isNaN(data.frameCount)) {
      throw new Error('Invalid integer values for water or frameCount fields');
    }
  }

  /**
   * Get nested object value by dot notation
   * @param {Object} obj - Object to traverse
   * @param {string} path - Dot-separated path
   * @returns {*} Value at path
   */
  getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current && current[key], obj);
  }

  /**
   * Notify all registered data handlers
   * @param {Object} parsedData - Parsed data object
   */
  notifyDataHandlers(parsedData) {
    this.dataHandlers.forEach(handler => {
      try {
        handler(parsedData);
      } catch (error) {
        console.error('Data handler error:', error);
      }
    });
  }

  /**
   * Record parse error for debugging and monitoring
   * @param {Error} error - Parse error
   * @param {string} rawData - Raw data that caused the error
   */
  recordParseError(error, rawData) {
    this.parseErrors.push({
      error: error.message,
      rawData: rawData,
      timestamp: Date.now()
    });

    // Limit error history to prevent memory leaks
    if (this.parseErrors.length > 100) {
      this.parseErrors = this.parseErrors.slice(-50);
    }
  }

  /**
   * Register callback for serial data events
   * @param {Function} callback - Data handler function
   * @returns {Function} Unsubscribe function
   */
  onSerialData(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    this.dataHandlers.push(callback);
    
    // Return unsubscribe function
    return () => {
      const index = this.dataHandlers.indexOf(callback);
      if (index !== -1) {
        this.dataHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Send command to serial port
   * @param {string} command - Command string to send
   * @returns {Promise<boolean>} Success status
   */
  async sendSerialCommand(command) {
    if (!this.serialWrapper) {
      throw new Error('Serial port not initialized');
    }

    if (this.connectionState !== 'connected') {
      throw new Error(`Cannot send command: serial port is ${this.connectionState}`);
    }

    try {
      await this.serialWrapper.write(command);
      return true;
    } catch (error) {
      throw new Error(`Failed to send command: ${error.message}`);
    }
  }

  /**
   * Close serial connection and cleanup resources
   * @returns {Promise<boolean>} Success status
   */
  async closeSerial() {
    if (!this.serialWrapper) {
      return true;
    }

    if (this.connectionState === 'disconnected') {
      return true;
    }

    try {
      await this.serialWrapper.close();
      this.connectionState = 'disconnected';
      this.serialWrapper = null;
      this.serialHandle = null;
      return true;
    } catch (error) {
      throw new Error(`Failed to close serial port: ${error.message}`);
    }
  }

  /**
   * Get current connection state
   * @returns {string} Connection state
   */
  getConnectionState() {
    return this.connectionState;
  }

  /**
   * Get last received data
   * @returns {Object|null} Last parsed data or null
   */
  getLastData() {
    return this.lastDataReceived;
  }

  /**
   * Get parse error history
   * @returns {Array} Array of parse error objects
   */
  getParseErrors() {
    return [...this.parseErrors];
  }

  /**
   * Clear parse error history
   */
  clearParseErrors() {
    this.parseErrors = [];
  }

  /**
   * Check if serial connection is active
   * @returns {boolean} Connection status
   */
  isConnected() {
    return this.connectionState === 'connected';
  }

  /**
   * Get serial connection statistics
   * @returns {Object} Connection and data statistics
   */
  getSerialStats() {
    return {
      isConnected: this.isConnected(),
      connectionState: this.connectionState,
      isInitialized: this.isInitialized,
      dataHandlerCount: this.dataHandlers.length,
      parseErrorCount: this.parseErrors.length,
      lastDataTime: this.lastDataReceived ? this.lastDataReceived.parsedAt : null,
      bufferSize: this.dataBuffer.length
    };
  }

  /**
   * Request serial hardware from hardware manager
   * This is a placeholder that would typically interface with HardwareManager
   * @param {Object} config - Serial configuration
   * @returns {Object} Serial wrapper instance
   */
  async requestSerialHardware(config) {
    // This would typically use dependency injection or service locator
    // For now, we'll simulate the hardware manager interface
    throw new Error('Serial hardware request not implemented - requires HardwareManager integration');
  }

  /**
   * Cleanup experiment resources
   */
  async cleanup() {
    try {
      // Close serial connection
      await this.closeSerial();
      
      // Clear handlers and buffers
      this.dataHandlers = [];
      this.dataBuffer = '';
      this.parseErrors = [];
      this.lastDataReceived = null;
      this.isInitialized = false;
      
      return true;
    } catch (error) {
      console.error('Cleanup error:', error);
      return false;
    }
  }
}