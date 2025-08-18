/**
 * Example Serial + Reward Experiment
 * 
 * This example shows how to create a complete experiment in a single file.
 * Users can copy this template and modify it for their specific needs.
 * 
 * Features demonstrated:
 * - Custom serial data parsing
 * - Position-based reward delivery
 * - Trial management
 * - Custom IPC handlers
 * - Event callbacks
 */

import { BaseExperiment } from '../src/experiments/BaseExperiment.js';

export default class ExampleSerialRewardExperiment extends BaseExperiment {
  constructor(userConfig = {}) {
    super({
      name: 'Example Serial Reward Experiment',
      version: '1.0.0',
      
      // USER-DEFINED: Serial configuration (users can override these)
      serial: {
        port: userConfig.serialPort || 'COM5',                    // User choice
        baudRate: userConfig.serialBaudRate || 9600,              // User choice  
        initialization: userConfig.serialInit || '5000,25,5,1\n'  // User choice
      },
      
      // USER-DEFINED: Reward configuration (users can override these)
      rewards: {
        hardware: userConfig.rewardHardware || 'python-script',   // User choice
        scriptPath: userConfig.rewardScript || './my-reward.py',  // User choice
        cooldownMs: userConfig.rewardCooldown || 1500,            // User choice
        maxRewardsPerTrial: userConfig.maxRewards || 3,           // User choice
        testMode: userConfig.testMode || false                    // User choice
      },
      
      // USER-DEFINED: Data logging (users can override these)
      logging: {
        path: userConfig.logPath || './my-experiment-data',       // User choice
        format: userConfig.logFormat || 'csv',                   // User choice
        filename: userConfig.logFilename || 'trial-data.csv'     // User choice
      },
      
      // USER-DEFINED: Experiment settings (users can override these)
      rewardZones: userConfig.rewardZones || [
        { x: 15, y: 25, radius: 4, name: 'My Goal Zone 1' },     // User choice
        { x: -15, y: 20, radius: 6, name: 'My Goal Zone 2' }     // User choice
      ],
      
      trialTimeoutMs: userConfig.trialTimeout || 45000,          // User choice (45 seconds)
      
      // USER-DEFINED: Custom IPC handler names (users can override these)
      ipcNames: {
        serialInit: userConfig.serialInitHandler || 'my-custom-serial-init',
        serialClose: userConfig.serialCloseHandler || 'my-custom-serial-close',
        rewardInit: userConfig.rewardInitHandler || 'my-custom-reward-init', 
        rewardDeliver: userConfig.rewardDeliverHandler || 'my-custom-deliver-reward',
        logData: userConfig.logDataHandler || 'my-custom-log-data',
        getStatus: userConfig.getStatusHandler || 'my-experiment-get-status',
        reset: userConfig.resetHandler || 'my-experiment-reset'
      },
      
      ...userConfig
    });
    
    // Custom experiment state
    this.currentPosition = { x: 0, y: 0, theta: 0 };
    this.visitedZones = new Set();
    this.trialData = [];
    this.serialHandle = null;
    this.rewardHandle = null;
    this.logHandle = null;
  }

  /**
   * Custom initialization logic
   * This runs after the base class initialization
   */
  async onInitialize() {
    console.log(`Starting ${this.name} v${this.version}`);
    
    // Initialize both serial and rewards automatically
    try {
      await this.initializeSerial();
      await this.initializeRewards();
      console.log('Hardware initialized successfully');
    } catch (error) {
      console.error('Hardware initialization failed:', error);
      // Continue anyway for testing
    }
    
    // Start first trial
    this.startTrial({ type: 'automatic' });
  }

  /**
   * Custom serial data parsing
   * Override the default 13-value CSV parser if needed
   */
  parseSerialData(rawData) {
    // Use the default parser, but could customize here
    const data = super.parseSerialData(rawData);
    
    // Add custom processing
    data.speed = Math.sqrt(
      Math.pow(data.leftSensor.dx, 2) + Math.pow(data.leftSensor.dy, 2)
    );
    
    return data;
  }

  /**
   * Handle incoming serial data
   * This is called for every parsed data point
   */
  onSerialData(data) {
    // Update current position
    this.currentPosition = {
      x: data.x,
      y: data.y,
      theta: data.theta
    };
    
    // Check if we're in a reward zone
    this.checkRewardZones(data);
    
    // Log data for trial analysis
    this.trialData.push({
      timestamp: data.parsedAt,
      position: { ...this.currentPosition },
      speed: data.speed,
      trialTime: this.getTrialTime()
    });
    
    // Send position to renderer for scene updates
    if (this.sceneUpdateCallback) {
      this.sceneUpdateCallback(data.x, data.y, data.theta);
    }
  }

  /**
   * Check if current position is in any reward zones
   */
  checkRewardZones(data) {
    for (const zone of this.config.rewardZones) {
      const distance = Math.sqrt(
        Math.pow(data.x - zone.x, 2) + Math.pow(data.y - zone.y, 2)
      );
      
      if (distance <= zone.radius) {
        const zoneKey = `${zone.x},${zone.y}`;
        
        // Only deliver reward if we haven't been in this zone recently
        if (!this.visitedZones.has(zoneKey)) {
          this.visitedZones.add(zoneKey);
          
          // Attempt to deliver reward
          this.deliverReward({
            reason: 'entered_zone',
            zone: zone.name,
            position: { x: data.x, y: data.y },
            distance: distance
          }).catch(error => {
            console.log('Reward delivery failed:', error.message);
          });
        }
      }
    }
  }

  /**
   * Custom reward delivery conditions
   * Return true if reward should be delivered, false otherwise
   */
  shouldDeliverReward(context) {
    // Always allow zone-based rewards
    if (context.reason === 'entered_zone') {
      return true;
    }
    
    // Allow manual rewards
    if (context.reason === 'manual') {
      return true;
    }
    
    // Deny other reasons
    return false;
  }

  /**
   * Handle successful reward delivery
   */
  onRewardDelivered(rewardEvent) {
    console.log(`Reward ${rewardEvent.id} delivered: ${rewardEvent.context.reason}`);
    
    // Check if trial should end (max rewards reached)
    if (this.getCurrentTrialRewards() >= this.config.rewards.maxRewardsPerTrial) {
      setTimeout(() => {
        this.endTrial({ reason: 'max_rewards_reached' });
        this.startNewTrialAfterDelay();
      }, 1000);
    }
  }

  /**
   * Handle trial start
   */
  onTrialStart(trialEvent) {
    console.log(`Trial ${trialEvent.trialNumber} started`);
    
    // Reset trial-specific state
    this.visitedZones.clear();
    this.trialData = [];
    
    // Set trial timeout
    if (this.trialTimeout) {
      clearTimeout(this.trialTimeout);
    }
    
    this.trialTimeout = setTimeout(() => {
      this.endTrial({ reason: 'timeout' });
      this.startNewTrialAfterDelay();
    }, this.config.trialTimeoutMs);
  }

  /**
   * Handle trial end
   */
  onTrialEnd(trialEndEvent) {
    console.log(`Trial ${trialEndEvent.trialNumber} ended: ${trialEndEvent.context.reason}`);
    console.log(`Duration: ${trialEndEvent.duration}ms, Rewards: ${trialEndEvent.rewardCount}`);
    
    // Clear timeout
    if (this.trialTimeout) {
      clearTimeout(this.trialTimeout);
      this.trialTimeout = null;
    }
    
    // Save trial data (in real experiment, save to file)
    this.saveTrialData(trialEndEvent);
  }

  /**
   * Start new trial after a delay
   */
  startNewTrialAfterDelay() {
    setTimeout(() => {
      this.startTrial({ type: 'automatic' });
    }, 3000); // 3 second break between trials
  }

  /**
   * Save trial data for analysis
   */
  saveTrialData(trialEndEvent) {
    const trialSummary = {
      trialNumber: trialEndEvent.trialNumber,
      startTime: trialEndEvent.startTime,
      endTime: trialEndEvent.endTime,
      duration: trialEndEvent.duration,
      rewardCount: trialEndEvent.rewardCount,
      endReason: trialEndEvent.context.reason,
      totalDataPoints: this.trialData.length,
      averageSpeed: this.calculateAverageSpeed(),
      zonesVisited: this.visitedZones.size
    };
    
    console.log('Trial Summary:', trialSummary);
    
    // In a real experiment, you would save this to a file:
    // await this.saveToFile(`trial_${trialEndEvent.trialNumber}.json`, {
    //   summary: trialSummary,
    //   rawData: this.trialData
    // });
  }

  /**
   * Calculate average speed for current trial
   */
  calculateAverageSpeed() {
    if (this.trialData.length === 0) return 0;
    
    const totalSpeed = this.trialData.reduce((sum, point) => sum + point.speed, 0);
    return totalSpeed / this.trialData.length;
  }

  /**
   * Custom IPC handlers for this experiment
   * Users define their own handler names and configurations
   */
  getCustomHandlers() {
    return {
      // User-defined serial communication handlers
      'my-custom-serial-init': async (event, userConfig = {}) => {
        try {
          // User defines their own serial configuration
          const serialConfig = {
            port: userConfig.port || 'COM5',           // User choice
            baudRate: userConfig.baudRate || 9600,     // User choice  
            initialization: userConfig.initString || '5000,25,5,1\n', // User choice
            logPath: userConfig.logPath || './my-experiment-data',      // User choice
            dataHandler: (serialData) => {
              this.onSerialData(serialData)
              // Send to renderer with user-defined event name
              this.sendToRenderer('my-position-update', serialData)
            }
          }
          
          const handle = await this.requestHardware('serial-port', serialConfig)
          this.serialHandle = handle
          return { success: true, message: 'My custom serial initialized' }
        } catch (error) {
          return { success: false, error: error.message }
        }
      },
      
      'my-custom-serial-close': async (event) => {
        try {
          if (this.serialHandle) {
            await this.releaseHardware(this.serialHandle)
            this.serialHandle = null
          }
          return { success: true }
        } catch (error) {
          return { success: false, error: error.message }
        }
      },
      
      // User-defined reward handlers
      'my-custom-reward-init': async (event, userConfig = {}) => {
        try {
          const rewardConfig = {
            hardware: userConfig.hardware || 'python-script',  // User choice
            scriptPath: userConfig.scriptPath || './my-reward-script.py', // User choice
            cooldown: userConfig.cooldown || 2000,             // User choice
            testMode: userConfig.testMode || false             // User choice
          }
          
          const handle = await this.requestHardware('water-delivery', rewardConfig)
          this.rewardHandle = handle
          return { success: true, message: 'My custom reward system initialized' }
        } catch (error) {
          return { success: false, error: error.message }
        }
      },
      
      'my-custom-deliver-reward': async (event, context = {}) => {
        try {
          if (!this.rewardHandle) {
            throw new Error('Reward system not initialized')
          }
          
          const result = await this.deliverReward({
            handle: this.rewardHandle,
            context: {
              reason: context.reason || 'manual',
              position: this.currentPosition,
              trialTime: this.getTrialTime(),
              ...context
            }
          })
          
          return result
        } catch (error) {
          return { success: false, error: error.message }
        }
      },
      
      // User-defined data logging
      'my-custom-log-data': async (event, data) => {
        try {
          const logConfig = {
            format: 'csv',                              // User choice
            path: './my-experiment-logs',               // User choice
            filename: `trial-${Date.now()}.csv`        // User choice
          }
          
          if (!this.logHandle) {
            this.logHandle = await this.requestHardware('data-logging', logConfig)
          }
          
          await this.logData(this.logHandle, data)
          return { success: true }
        } catch (error) {
          return { success: false, error: error.message }
        }
      },
      
      // User-defined experiment control
      'my-experiment-get-status': async (event) => {
        return {
          name: this.name,
          currentTrial: this.trialCounter,
          trialTime: this.getTrialTime(),
          position: this.currentPosition,
          zonesVisited: this.visitedZones.size,
          rewardsEarned: this.getCurrentTrialRewards(),
          isActive: this.isTrialActive
        }
      },
      
      'my-experiment-reset': async (event) => {
        try {
          this.resetTrial()
          return { success: true, message: 'My experiment reset successfully' }
        } catch (error) {
          return { success: false, error: error.message }
        }
      }
    }
  }

  /**
   * Set callback for scene updates
   * This allows the 3D scene to update player position
   */
  setSceneUpdateCallback(callback) {
    this.sceneUpdateCallback = callback;
  }

  /**
   * Custom cleanup logic
   */
  async onCleanup() {
    console.log('Cleaning up experiment...');
    
    // Clear timeouts
    if (this.trialTimeout) {
      clearTimeout(this.trialTimeout);
    }
    
    // Save final session data
    console.log(`Session complete: ${this.trialCounter} trials, ${this.rewardCount} total rewards`);
  }
}

// Export configuration for the experiment loader
export const experimentConfig = {
  name: "Example Serial Reward Experiment",
  version: "1.0.0",
  description: "Demonstrates serial communication with position-based reward delivery",
  
  hardware: {
    required: ["serial-port"],
    optional: ["water-delivery"]
  },
  
  // Compatible scene configurations
  scenes: {
    compatible: ["hallway", "custom-serial"],
    recommended: "hallway"
  },
  
  // Default configuration that users can override
  defaultConfig: {
    serial: {
      port: 'COM3',
      baudRate: 115200
    },
    rewards: {
      cooldownMs: 2000,
      maxRewardsPerTrial: 5
    },
    rewardZones: [
      { x: 10, y: 20, radius: 5, name: 'Goal Zone 1' }
    ]
  }
};