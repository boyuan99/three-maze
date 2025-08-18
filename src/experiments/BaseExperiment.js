/**
 * BaseExperiment - Unified base class for creating complete experiments
 * 
 * This class combines all experiment functionality in a single file:
 * - Serial communication management
 * - Reward delivery system
 * - Hardware resource management
 * - IPC handler registration
 * - Data logging and statistics
 * 
 * Users can extend this class to create custom experiments by defining:
 * - Serial data parsing logic
 * - Reward delivery conditions
 * - Custom IPC handlers
 * - Trial management
 */

export class BaseExperiment {
  constructor(config = {}) {
    this.name = config.name || 'Custom Experiment';
    this.version = config.version || '1.0.0';
    this.config = config;
    
    // Core state
    this.isInitialized = false;
    this.hardwareHandles = new Map();
    this.ipcHandlers = new Map();
    
    // Serial communication state
    this.serialHandle = null;
    this.serialWrapper = null;
    this.connectionState = 'disconnected';
    this.lastDataReceived = null;
    this.dataBuffer = '';
    this.parseErrors = [];
    this.dataHandlers = [];
    
    // Reward system state
    this.rewardHandle = null;
    this.rewardWrapper = null;
    this.rewardCount = 0;
    this.rewardHistory = [];
    this.rewardHandlers = [];
    
    // Trial management state
    this.trialStartTime = null;
    this.sessionStartTime = null;
    this.trialCounter = 0;
    this.trialHandlers = [];
    
    // Hardware manager reference (injected during initialization)
    this.hardwareManager = null;
  }

  /**
   * Initialize the experiment
   * Override this method to add custom initialization logic
   * @param {Object} hardwareManager - HardwareManager instance
   */
  async initialize(hardwareManager) {
    this.hardwareManager = hardwareManager;
    this.sessionStartTime = Date.now();
    this.isInitialized = true;
    
    // Call user-defined initialization
    if (this.onInitialize) {
      await this.onInitialize();
    }
    
    return true;
  }

  /**
   * Get IPC handlers that this experiment provides
   * Override this method to add custom IPC handlers
   * @returns {Object} Map of handler names to functions
   */
  getIpcHandlers() {
    const handlers = {
      // Serial communication handlers
      'experiment-initialize-serial': async (event, config) => {
        return await this.initializeSerial(config);
      },
      
      'experiment-send-serial-command': async (event, command) => {
        return await this.sendSerialCommand(command);
      },
      
      'experiment-get-serial-status': async (event) => {
        return this.getSerialStatus();
      },
      
      // Reward system handlers
      'experiment-initialize-rewards': async (event, config) => {
        return await this.initializeRewards(config);
      },
      
      'experiment-deliver-reward': async (event, context) => {
        return await this.deliverReward(context);
      },
      
      'experiment-get-reward-stats': async (event) => {
        return this.getRewardStats();
      },
      
      // Trial management handlers
      'experiment-start-trial': async (event, context) => {
        return this.startTrial(context);
      },
      
      'experiment-end-trial': async (event, context) => {
        return this.endTrial(context);
      },
      
      'experiment-reset-trial': async (event) => {
        return this.resetTrial();
      },
      
      // General experiment handlers
      'experiment-get-status': async (event) => {
        return this.getExperimentStatus();
      }
    };

    // Add user-defined handlers
    if (this.getCustomHandlers) {
      const customHandlers = this.getCustomHandlers();
      Object.assign(handlers, customHandlers);
    }

    return handlers;
  }

  /**
   * Initialize serial communication
   * Override parseSerialData() method to customize data parsing
   * @param {Object} config - Serial configuration
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

    const serialConfig = { ...defaultConfig, ...this.config.serial, ...config };
    
    try {
      // Request serial hardware
      this.serialHandle = await this.hardwareManager.requestResource(
        'serial-port', 
        serialConfig, 
        this.name
      );
      
      this.serialWrapper = this.hardwareManager.getResource(this.serialHandle);
      
      // Set up event handlers
      this.setupSerialEventHandlers();

      // Send initialization string if specified
      if (serialConfig.initialization && serialConfig.initialization.trim()) {
        await this.sendSerialCommand(serialConfig.initialization);
      }

      return { success: true, handle: this.serialHandle };

    } catch (error) {
      this.connectionState = 'error';
      throw new Error(`Failed to initialize serial port: ${error.message}`);
    }
  }

  /**
   * Set up serial event handlers
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
      this.dataBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          try {
            const parsedData = this.parseSerialData(trimmedLine);
            this.lastDataReceived = parsedData;
            
            // Notify all data handlers
            this.notifyDataHandlers(parsedData);
            
            // Call user-defined data handler
            if (this.onSerialData) {
              this.onSerialData(parsedData);
            }
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
   * Parse serial data - OVERRIDE THIS METHOD
   * Default implementation parses 13-value CSV format
   * @param {string} rawData - Raw CSV data string
   * @returns {Object} Parsed data object
   */
  parseSerialData(rawData) {
    const values = rawData.split(',');
    
    if (values.length < 13) {
      throw new Error(`Invalid serial data format: expected 13 values, got ${values.length}`);
    }

    try {
      return {
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
    } catch (error) {
      throw new Error(`Failed to parse serial data: ${error.message}`);
    }
  }

  /**
   * Send command to serial port
   * @param {string} command - Command string to send
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
   * Initialize reward delivery system
   * Override shouldDeliverReward() method to customize delivery logic
   * @param {Object} config - Reward configuration
   */
  async initializeRewards(config = {}) {
    const defaultConfig = {
      hardware: 'python-script',
      cooldownMs: 1000,
      counting: true,
      logging: true,
      maxRewardsPerTrial: null,
      testMode: false,
      deliveryDurationMs: 100,
      maxDeliveriesPerMinute: 60
    };

    const rewardConfig = { ...defaultConfig, ...this.config.rewards, ...config };
    
    try {
      // Request reward hardware
      this.rewardHandle = await this.hardwareManager.requestResource(
        'water-delivery', 
        rewardConfig, 
        this.name
      );
      
      this.rewardWrapper = this.hardwareManager.getResource(this.rewardHandle);
      
      return { success: true, handle: this.rewardHandle };
    } catch (error) {
      throw new Error(`Failed to initialize reward system: ${error.message}`);
    }
  }

  /**
   * Deliver reward with cooldown and limit enforcement
   * Override shouldDeliverReward() to customize delivery conditions
   * @param {Object} context - Reward delivery context
   */
  async deliverReward(context = {}) {
    if (!this.rewardWrapper) {
      throw new Error('Reward system not initialized');
    }

    const now = Date.now();

    try {
      // Check if reward should be delivered (user-defined logic)
      if (this.shouldDeliverReward && !this.shouldDeliverReward(context)) {
        return { success: false, reason: 'User-defined condition not met' };
      }

      // Check cooldown period
      this.enforceCooldownPeriod(now);

      // Check trial limits
      this.enforceTrialLimits();

      // Deliver reward through hardware
      const deliveryResult = await this.rewardWrapper.deliverWater(context.amount || 1);
      
      // Update counters and history
      this.rewardCount++;
      const rewardEvent = this.createRewardEvent(now, context, deliveryResult);
      this.rewardHistory.push(rewardEvent);

      // Notify handlers
      this.notifyRewardHandlers(rewardEvent);
      
      // Call user-defined reward handler
      if (this.onRewardDelivered) {
        this.onRewardDelivered(rewardEvent);
      }

      return {
        success: true,
        rewardId: rewardEvent.id,
        totalRewards: this.rewardCount,
        trialRewards: this.getCurrentTrialRewards(),
        timestamp: now
      };

    } catch (error) {
      // Log failed delivery attempt
      const failedEvent = this.createFailedRewardEvent(now, context, error);
      this.rewardHistory.push(failedEvent);
      throw error;
    }
  }

  /**
   * Override this method to define custom reward delivery conditions
   * @param {Object} context - Reward context
   * @returns {boolean} True if reward should be delivered
   */
  shouldDeliverReward(context) {
    // Default implementation - always deliver if called
    return true;
  }

  /**
   * Start a new trial
   * @param {Object} context - Trial context
   */
  startTrial(context = {}) {
    const now = Date.now();
    this.trialStartTime = now;
    this.trialCounter++;
    
    const trialEvent = {
      trialNumber: this.trialCounter,
      startTime: now,
      context: { ...context }
    };

    // Notify trial handlers
    this.notifyTrialHandlers(trialEvent);
    
    // Call user-defined trial start handler
    if (this.onTrialStart) {
      this.onTrialStart(trialEvent);
    }

    return trialEvent;
  }

  /**
   * End current trial
   * @param {Object} context - Trial end context
   */
  endTrial(context = {}) {
    if (!this.trialStartTime) {
      throw new Error('No active trial to end');
    }

    const now = Date.now();
    const trialDuration = now - this.trialStartTime;
    const trialRewards = this.getCurrentTrialRewards();

    const trialEndEvent = {
      trialNumber: this.trialCounter,
      startTime: this.trialStartTime,
      endTime: now,
      duration: trialDuration,
      rewardCount: trialRewards,
      context: { ...context }
    };

    // Call user-defined trial end handler
    if (this.onTrialEnd) {
      this.onTrialEnd(trialEndEvent);
    }

    this.trialStartTime = null;
    return trialEndEvent;
  }

  /**
   * Reset trial (start new trial immediately)
   */
  resetTrial() {
    if (this.trialStartTime) {
      this.endTrial({ type: 'reset' });
    }
    return this.startTrial({ type: 'reset' });
  }

  /**
   * Get comprehensive experiment status
   */
  getExperimentStatus() {
    return {
      name: this.name,
      version: this.version,
      isInitialized: this.isInitialized,
      
      serial: {
        connectionState: this.connectionState,
        isConnected: this.connectionState === 'connected',
        lastDataTime: this.lastDataReceived ? this.lastDataReceived.parsedAt : null,
        parseErrorCount: this.parseErrors.length
      },
      
      rewards: {
        isInitialized: !!this.rewardWrapper,
        totalRewards: this.rewardCount,
        currentTrialRewards: this.getCurrentTrialRewards(),
        lastRewardTime: this.getLastRewardTime()
      },
      
      trial: {
        isActive: !!this.trialStartTime,
        currentTrialNumber: this.trialCounter,
        trialDuration: this.getTrialTime(),
        sessionDuration: this.getSessionTime()
      }
    };
  }

  /**
   * Get serial communication status
   */
  getSerialStatus() {
    return {
      connectionState: this.connectionState,
      isConnected: this.connectionState === 'connected',
      lastDataTime: this.lastDataReceived ? this.lastDataReceived.parsedAt : null,
      parseErrorCount: this.parseErrors.length,
      bufferSize: this.dataBuffer.length
    };
  }

  /**
   * Get reward statistics
   */
  getRewardStats() {
    const successfulRewards = this.rewardHistory.filter(r => r.success !== false);
    const failedRewards = this.rewardHistory.filter(r => r.success === false);
    
    return {
      totalRewards: this.rewardCount,
      successfulDeliveries: successfulRewards.length,
      failedDeliveries: failedRewards.length,
      successRate: this.rewardHistory.length > 0 ? successfulRewards.length / this.rewardHistory.length : 0,
      currentTrialRewards: this.getCurrentTrialRewards(),
      sessionDuration: this.getSessionTime(),
      currentTrialDuration: this.getTrialTime(),
      averageRewardInterval: this.calculateAverageRewardInterval(),
      lastRewardTime: this.getLastRewardTime()
    };
  }

  // ========== Helper Methods ==========

  enforceCooldownPeriod(now) {
    if (this.rewardHistory.length > 0) {
      const lastSuccessfulReward = this.getLastSuccessfulReward();
      if (lastSuccessfulReward) {
        const cooldownMs = this.rewardWrapper.config?.cooldownMs || this.config.rewards?.cooldownMs || 1000;
        const timeSinceLastReward = now - lastSuccessfulReward.timestamp;
        
        if (timeSinceLastReward < cooldownMs) {
          throw new Error(`Cooldown active: wait ${cooldownMs - timeSinceLastReward}ms`);
        }
      }
    }
  }

  enforceTrialLimits() {
    const maxRewardsPerTrial = this.config.rewards?.maxRewardsPerTrial;
    if (maxRewardsPerTrial) {
      const currentTrialRewards = this.getCurrentTrialRewards();
      if (currentTrialRewards >= maxRewardsPerTrial) {
        throw new Error(`Maximum rewards per trial (${maxRewardsPerTrial}) reached`);
      }
    }
  }

  createRewardEvent(timestamp, context, deliveryResult) {
    return {
      id: this.rewardCount,
      timestamp: timestamp,
      trialStartTime: this.trialStartTime,
      sessionTime: timestamp - this.sessionStartTime,
      context: { ...context },
      deliveryResult: deliveryResult,
      trialNumber: this.trialCounter,
      success: true
    };
  }

  createFailedRewardEvent(timestamp, context, error) {
    return {
      timestamp: timestamp,
      error: error.message,
      context: { ...context },
      success: false,
      trialNumber: this.trialCounter,
      trialStartTime: this.trialStartTime
    };
  }

  notifyDataHandlers(parsedData) {
    this.dataHandlers.forEach(handler => {
      try {
        handler(parsedData);
      } catch (error) {
        console.error('Data handler error:', error);
      }
    });
  }

  notifyRewardHandlers(rewardEvent) {
    this.rewardHandlers.forEach(handler => {
      try {
        handler(rewardEvent);
      } catch (error) {
        console.error('Reward handler error:', error);
      }
    });
  }

  notifyTrialHandlers(trialEvent) {
    this.trialHandlers.forEach(handler => {
      try {
        handler(trialEvent);
      } catch (error) {
        console.error('Trial handler error:', error);
      }
    });
  }

  recordParseError(error, rawData) {
    this.parseErrors.push({
      error: error.message,
      rawData: rawData,
      timestamp: Date.now()
    });

    if (this.parseErrors.length > 100) {
      this.parseErrors = this.parseErrors.slice(-50);
    }
  }

  getCurrentTrialRewards() {
    if (!this.trialStartTime) {
      return 0;
    }

    return this.rewardHistory.filter(reward => 
      reward.success !== false && reward.timestamp >= this.trialStartTime
    ).length;
  }

  getTrialTime() {
    if (!this.trialStartTime) {
      return 0;
    }
    return Date.now() - this.trialStartTime;
  }

  getSessionTime() {
    if (!this.sessionStartTime) {
      return 0;
    }
    return Date.now() - this.sessionStartTime;
  }

  getLastSuccessfulReward() {
    const successfulRewards = this.rewardHistory.filter(r => r.success !== false);
    return successfulRewards.length > 0 ? successfulRewards[successfulRewards.length - 1] : null;
  }

  getLastRewardTime() {
    const lastReward = this.getLastSuccessfulReward();
    return lastReward ? lastReward.timestamp : null;
  }

  calculateAverageRewardInterval() {
    const successfulRewards = this.rewardHistory.filter(r => r.success !== false);
    
    if (successfulRewards.length < 2) {
      return null;
    }

    const intervals = [];
    for (let i = 1; i < successfulRewards.length; i++) {
      intervals.push(successfulRewards[i].timestamp - successfulRewards[i - 1].timestamp);
    }

    return intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
  }

  /**
   * Register event callbacks (for advanced users)
   */
  onData(callback) {
    this.dataHandlers.push(callback);
    return () => {
      const index = this.dataHandlers.indexOf(callback);
      if (index !== -1) this.dataHandlers.splice(index, 1);
    };
  }

  onReward(callback) {
    this.rewardHandlers.push(callback);
    return () => {
      const index = this.rewardHandlers.indexOf(callback);
      if (index !== -1) this.rewardHandlers.splice(index, 1);
    };
  }

  onTrial(callback) {
    this.trialHandlers.push(callback);
    return () => {
      const index = this.trialHandlers.indexOf(callback);
      if (index !== -1) this.trialHandlers.splice(index, 1);
    };
  }

  /**
   * Cleanup experiment resources
   */
  async cleanup() {
    try {
      // Release hardware resources
      if (this.serialHandle) {
        await this.hardwareManager.releaseResource(this.serialHandle);
        this.serialHandle = null;
        this.serialWrapper = null;
      }

      if (this.rewardHandle) {
        await this.hardwareManager.releaseResource(this.rewardHandle);
        this.rewardHandle = null;
        this.rewardWrapper = null;
      }

      // Clear handlers and buffers
      this.dataHandlers = [];
      this.rewardHandlers = [];
      this.trialHandlers = [];
      this.dataBuffer = '';
      this.parseErrors = [];
      this.isInitialized = false;

      // Call user-defined cleanup
      if (this.onCleanup) {
        await this.onCleanup();
      }
      
      return true;
    } catch (error) {
      console.error('Cleanup error:', error);
      return false;
    }
  }
}

export default BaseExperiment;