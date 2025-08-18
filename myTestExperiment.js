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
  constructor(config = {}) {
    super({
      name: 'Example Serial Reward Experiment',
      version: '1.0.0',
      
      // Serial configuration
      serial: {
        port: 'COM3',
        baudRate: 115200,
        initialization: '10000,50,10,1\n'
      },
      
      // Reward configuration  
      rewards: {
        cooldownMs: 2000,           // 2 second cooldown between rewards
        maxRewardsPerTrial: 5,      // Maximum 5 rewards per trial
        testMode: false             // Set to true for testing without hardware
      },
      
      // Custom experiment settings
      rewardZones: [
        { x: 10, y: 20, radius: 5, name: 'Goal Zone 1' },
        { x: -10, y: 15, radius: 3, name: 'Goal Zone 2' }
      ],
      
      trialTimeoutMs: 60000,        // 1 minute trial timeout
      
      ...config
    });
    
    // Custom experiment state
    this.currentPosition = { x: 0, y: 0, theta: 0 };
    this.visitedZones = new Set();
    this.trialData = [];
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
   * These will be available to the renderer process
   */
  getCustomHandlers() {
    return {
      'experiment-get-position': async (event) => {
        return this.currentPosition;
      },
      
      'experiment-get-zones': async (event) => {
        return this.config.rewardZones;
      },
      
      'experiment-manual-reward': async (event, context = {}) => {
        return await this.deliverReward({
          ...context,
          reason: 'manual'
        });
      },
      
      'experiment-get-trial-data': async (event) => {
        return {
          currentTrial: this.trialCounter,
          trialTime: this.getTrialTime(),
          dataPoints: this.trialData.length,
          zonesVisited: this.visitedZones.size,
          trialRewards: this.getCurrentTrialRewards()
        };
      },
      
      'experiment-force-end-trial': async (event, reason = 'manual') => {
        const result = this.endTrial({ reason });
        this.startNewTrialAfterDelay();
        return result;
      }
    };
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