/**
 * hallwaySerialMigrated.js
 * Migrated control logic from JsSerialHallwayScene.vue
 * 
 * This experiment uses the modular architecture where the experiment
 * defines its own IPC handlers and uses the ExperimentManager system.
 */

import { SerialExperiment } from '../src/experiments/SerialExperiment.js';
import { RewardExperiment } from '../src/experiments/RewardExperiment.js';

/**
 * Experiment configuration for ExperimentManager
 */
export const experimentConfig = {
  name: "Hallway Serial Migration",
  version: "1.0.0",
  description: "Migrated from JsSerialHallwayScene.vue using modular architecture",
  
  // Hardware requirements
  hardware: {
    required: ["serial-port"],
    optional: ["water-delivery", "data-logging"]
  },
  
  // Data collection configuration
  logging: {
    format: "tsv",
    fields: ["x", "y", "theta", "input_x", "input_y", "water", "timestamp"],
    path: "experiments/data/"
  },
  
  // Scene compatibility
  scenes: {
    compatible: ["hallway", "custom-hallway"],
    required: "hallway"
  },
  
  // IPC handlers this experiment will register
  handlers: [
    "initialize-js-serial",
    "close-js-serial",
    "deliver-water", 
    "append-to-log",
    "send-message"
  ]
};

/**
 * Base experiment class that provides the needed interface
 */
class BaseExperiment {
  constructor() {
    // Initialize serial experiment functionality
    this.serialExperiment = new SerialExperiment();
    
    // Initialize reward experiment functionality  
    this.rewardExperiment = new RewardExperiment();
    
    // Bind methods for easier access
    this.initializeSerial = this.serialExperiment.initializeSerial.bind(this.serialExperiment);
    this.closeSerial = this.serialExperiment.closeSerial.bind(this.serialExperiment);
    this.onSerialData = this.serialExperiment.onSerialData.bind(this.serialExperiment);
    this.sendSerialCommand = this.serialExperiment.sendSerialCommand.bind(this.serialExperiment);
    
    this.initializeRewards = this.rewardExperiment.initializeRewards.bind(this.rewardExperiment);
    this.deliverReward = this.rewardExperiment.deliverReward.bind(this.rewardExperiment);
    this.stopRewards = this.rewardExperiment.cleanup.bind(this.rewardExperiment);
    this.onRewardDelivered = this.rewardExperiment.onRewardDelivered.bind(this.rewardExperiment);
  }
  
  // Lifecycle methods to be implemented by subclasses
  async initialize() {
    throw new Error('Must implement initialize() method');
  }
  
  async cleanup() {
    throw new Error('Must implement cleanup() method');
  }
  
  // Placeholder methods for logging functionality
  async initializeLogging(config) {
    console.log('Logging initialized with config:', config);
  }
  
  async stopLogging() {
    console.log('Logging stopped');
  }
  
  async logEvent(data) {
    console.log('Log event:', data);
  }
  
  async logRawData(data) {
    console.log('Log raw data:', data);
  }
}

/**
 * Main experiment class for the modular architecture
 */
export default class HallwaySerialMigration extends BaseExperiment {
  constructor() {
    super();
    
    // Physics constants from original Vue file
    this.HALLWAY_LENGTH = 200;
    this.HALLWAY_WIDTH = 20;
    this.WALL_HEIGHT = 10;
    this.WALL_THICKNESS = 1;
    this.BLUE_SEGMENT_LENGTH = 30;
    this.PLAYER_RADIUS = 0.5;
    this.MAX_LINEAR_VELOCITY = 100;
    this.DT = 1/20;
    
    // Position tracking
    this.position = {
      x: 0,
      y: 0,
      theta: 0
    };
    
    // State management
    this.isActive = true;
    this.serialData = null;
    this.playerBody = null;
    this.fixedCam = null;
  }
  
  /**
   * Initialize experiment with hardware resources
   */
  async initialize() {
    console.log('Initializing Hallway Serial Migration experiment...');
    
    try {
      // Initialize serial communication
      await this.initializeSerial({
        port: "COM3",
        baudRate: 115200,
        parser: "line",
        initialization: "10000,50,10,1\n"
      });
      
      // Initialize reward system
      await this.initializeRewards({
        hardware: "python-script",
        cooldown: 1000,
        counting: true,
        logging: true
      });
      
      // Initialize data logging
      await this.initializeLogging({
        format: "tsv",
        autoFlush: true
      });
      
      // Set up serial data handler
      this.onSerialData(this.handleSerialData.bind(this));
      
      console.log('Hallway Serial Migration experiment initialized successfully');
      return { success: true };
      
    } catch (error) {
      console.error('Failed to initialize experiment:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Clean up experiment resources
   */
  async cleanup() {
    console.log('Cleaning up Hallway Serial Migration experiment...');
    
    this.isActive = false;
    
    try {
      // Stop serial communication
      await this.closeSerial();
      
      // Stop reward system
      await this.stopRewards();
      
      // Stop data logging
      await this.stopLogging();
      
      console.log('Hallway Serial Migration experiment cleanup completed');
      return { success: true };
      
    } catch (error) {
      console.error('Error during experiment cleanup:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Handle incoming serial data and update physics
   */
  handleSerialData(data) {
    if (!this.isActive || !this.playerBody) {
      return;
    }
    
    try {
      // Store data for processing
      this.serialData = {
        x: parseFloat(data.x) || 0,
        y: parseFloat(data.y) || 0,
        theta: parseFloat(data.theta) || 0,
        water: data.water || false,
        timestamp: data.timestamp || Date.now()
      };
      
      // Process movement data
      this.updatePlayerMovement(this.serialData);
      
      // Log the data
      this.logPositionData(this.serialData);
      
      // Check for trial reset condition
      this.checkTrialReset();
      
    } catch (error) {
      console.error('Error processing serial data:', error);
    }
  }
  
  /**
   * Update player movement based on serial input
   */
  updatePlayerMovement(data) {
    if (!this.playerBody) return;
    
    try {
      // Convert displacement to velocity by dividing by DT
      const vx = Math.min(Math.max(data.x * 0.0364 / this.DT, -this.MAX_LINEAR_VELOCITY), this.MAX_LINEAR_VELOCITY);
      const vy = Math.min(Math.max(data.y * 0.0364 / this.DT, -this.MAX_LINEAR_VELOCITY), this.MAX_LINEAR_VELOCITY);
      
      // Calculate world velocities based on current orientation
      const worldVx = vx * Math.cos(this.position.theta) - vy * Math.sin(this.position.theta);
      const worldVz = -vx * Math.sin(this.position.theta) - vy * Math.cos(this.position.theta);
      
      // Set linear velocity directly on physics body
      this.playerBody.setLinvel({
        x: worldVx,
        y: 0,
        z: worldVz
      }, true);
      
      // Update position based on physics body
      const bodyPosition = this.playerBody.translation();
      this.position.x = bodyPosition.x;
      this.position.y = bodyPosition.z;
      
      // Handle rotation separately
      const deltaTheta = data.theta * 0.05;
      this.position.theta += deltaTheta;
      
      // Set rotation directly
      this.playerBody.setRotation({
        x: 0,
        y: this.position.theta,
        z: 0
      }, true);
      
      // Update camera if available
      if (this.fixedCam) {
        this.fixedCam.update({
          position: {
            x: bodyPosition.x,
            y: bodyPosition.y + 2,
            z: bodyPosition.z
          },
          rotation: this.position.theta
        });
      }
      
    } catch (error) {
      console.error('Error updating player movement:', error);
    }
  }
  
  /**
   * Log position and input data
   */
  logPositionData(serialData) {
    try {
      const logData = `${this.position.x.toFixed(3)}\t${-this.position.y.toFixed(3)}\t${this.position.theta.toFixed(3)}\t${serialData.x || 0}\t${serialData.y || 0}\t${serialData.water ? 1 : 0}\t${serialData.timestamp}\n`;
      
      // Use the logging system
      this.logEvent({
        x: this.position.x,
        y: -this.position.y,
        theta: this.position.theta,
        input_x: serialData.x,
        input_y: serialData.y,
        water: serialData.water ? 1 : 0,
        timestamp: serialData.timestamp
      });
      
    } catch (error) {
      console.error('Error logging position data:', error);
    }
  }
  
  /**
   * Check for trial reset condition and handle reward delivery
   */
  async checkTrialReset() {
    try {
      if (Math.abs(this.position.y) >= 70) {
        console.log('Trial reset due to Y position limit');
        
        // Reset position
        this.position.x = 0;
        this.position.y = 0;
        this.position.theta = 0;
        
        // Reset player physics body position
        if (this.playerBody) {
          this.playerBody.setTranslation({ x: 0, y: 2, z: 0 }, true);
          this.playerBody.setRotation({ x: 0, y: 0, z: 0 }, true);
        }
        
        // Deliver water reward
        try {
          const result = await this.deliverReward({
            context: 'trial_completion',
            position: { ...this.position }
          });
          
          if (result.success) {
            console.log('Water delivered successfully');
          } else {
            console.error('Water delivery failed:', result.error);
          }
          
        } catch (error) {
          console.error('Error in water delivery:', error);
        }
      }
    } catch (error) {
      console.error('Error in trial reset check:', error);
    }
  }
  
  /**
   * Set scene references for physics interaction
   */
  setSceneReferences(playerBody, fixedCam) {
    this.playerBody = playerBody;
    this.fixedCam = fixedCam;
    console.log('Scene references set for experiment');
  }
  
  /**
   * Get current position for scene display
   */
  getPosition() {
    return { ...this.position };
  }
  
  /**
   * Get custom IPC handlers for this experiment
   */
  getCustomHandlers() {
    return {
      'initialize-js-serial': this.handleInitializeSerial.bind(this),
      'close-js-serial': this.handleCloseSerial.bind(this),
      'deliver-water': this.handleDeliverWater.bind(this),
      'append-to-log': this.handleAppendToLog.bind(this),
      'send-message': this.handleSendMessage.bind(this)
    };
  }
  
  /**
   * IPC handler for serial initialization
   */
  async handleInitializeSerial() {
    const result = await this.initialize();
    return result;
  }
  
  /**
   * IPC handler for serial closing
   */
  async handleCloseSerial() {
    const result = await this.cleanup();
    return result;
  }
  
  /**
   * IPC handler for water delivery
   */
  async handleDeliverWater() {
    try {
      const result = await this.deliverReward({
        context: 'manual_trigger'
      });
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * IPC handler for data logging
   */
  async handleAppendToLog(logData) {
    try {
      await this.logRawData(logData);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * IPC handler for sending messages
   */
  async handleSendMessage(message) {
    console.log('Experiment received message:', message);
    return { success: true };
  }
}