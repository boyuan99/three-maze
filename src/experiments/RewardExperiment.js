/**
 * RewardExperiment - Base class for experiments requiring reward delivery
 * 
 * This class provides:
 * - Water delivery system management with cooldown and limits
 * - Trial management and timing functionality
 * - Event tracking for reward delivery and trial progression
 * - Statistics and performance monitoring
 * - Error handling for hardware failures
 */

export class RewardExperiment {
  constructor(config = {}) {
    this.config = config;
    this.rewardHandle = null;
    this.rewardWrapper = null;
    this.rewardCount = 0;
    this.trialStartTime = null;
    this.sessionStartTime = null;
    this.rewardHistory = [];
    this.rewardHandlers = [];
    this.trialHandlers = [];
    this.isInitialized = false;
    this.trialCounter = 0;
  }

  /**
   * Initialize reward delivery system
   * @param {Object} config - Reward system configuration
   * @returns {string} Reward system handle
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

    const rewardConfig = { ...defaultConfig, ...this.config, ...config };
    
    try {
      // Request reward hardware from hardware manager
      this.rewardWrapper = await this.requestRewardHardware(rewardConfig);
      
      this.rewardHandle = `reward-system-${Date.now()}`;
      this.isInitialized = true;
      this.sessionStartTime = Date.now();
      
      return this.rewardHandle;
    } catch (error) {
      throw new Error(`Failed to initialize reward system: ${error.message}`);
    }
  }

  /**
   * Deliver reward with cooldown and limit enforcement
   * @param {Object} context - Reward delivery context and metadata
   * @returns {Object} Delivery result with statistics
   */
  async deliverReward(context = {}) {
    if (!this.isInitialized) {
      throw new Error('Reward system not initialized');
    }

    const now = Date.now();

    try {
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

      return {
        success: true,
        rewardId: rewardEvent.id,
        totalRewards: this.rewardCount,
        trialRewards: this.getCurrentTrialRewards(),
        timestamp: now,
        deliveryTime: deliveryResult.duration || this.config.deliveryDurationMs || 100
      };

    } catch (error) {
      // Log failed delivery attempt
      const failedEvent = this.createFailedRewardEvent(now, context, error);
      this.rewardHistory.push(failedEvent);
      throw error;
    }
  }

  /**
   * Enforce cooldown period between rewards
   * @param {number} now - Current timestamp
   */
  enforceCooldownPeriod(now) {
    if (this.rewardHistory.length > 0) {
      const lastSuccessfulReward = this.getLastSuccessfulReward();
      if (lastSuccessfulReward) {
        const cooldownMs = this.rewardWrapper.config?.cooldownMs || this.config.cooldownMs || 1000;
        const timeSinceLastReward = now - lastSuccessfulReward.timestamp;
        
        if (timeSinceLastReward < cooldownMs) {
          throw new Error(`Cooldown active: wait ${cooldownMs - timeSinceLastReward}ms`);
        }
      }
    }
  }

  /**
   * Enforce trial-based reward limits
   */
  enforceTrialLimits() {
    const maxRewardsPerTrial = this.config.maxRewardsPerTrial;
    if (maxRewardsPerTrial) {
      const currentTrialRewards = this.getCurrentTrialRewards();
      if (currentTrialRewards >= maxRewardsPerTrial) {
        throw new Error(`Maximum rewards per trial (${maxRewardsPerTrial}) reached`);
      }
    }
  }

  /**
   * Create reward event record
   * @param {number} timestamp - Event timestamp
   * @param {Object} context - Reward context
   * @param {Object} deliveryResult - Hardware delivery result
   * @returns {Object} Reward event object
   */
  createRewardEvent(timestamp, context, deliveryResult) {
    return {
      id: this.rewardCount,
      timestamp: timestamp,
      trialStartTime: this.trialStartTime,
      sessionTime: timestamp - this.sessionStartTime,
      context: { ...context },
      deliveryResult: deliveryResult,
      trialNumber: this.getCurrentTrialNumber(),
      success: true
    };
  }

  /**
   * Create failed reward event record
   * @param {number} timestamp - Event timestamp
   * @param {Object} context - Reward context
   * @param {Error} error - Failure error
   * @returns {Object} Failed reward event object
   */
  createFailedRewardEvent(timestamp, context, error) {
    return {
      timestamp: timestamp,
      error: error.message,
      context: { ...context },
      success: false,
      trialNumber: this.getCurrentTrialNumber(),
      trialStartTime: this.trialStartTime
    };
  }

  /**
   * Notify all reward event handlers
   * @param {Object} rewardEvent - Reward event to broadcast
   */
  notifyRewardHandlers(rewardEvent) {
    this.rewardHandlers.forEach(handler => {
      try {
        handler(rewardEvent);
      } catch (error) {
        console.error('Reward handler error:', error);
      }
    });
  }

  /**
   * Register callback for reward delivery events
   * @param {Function} callback - Event handler function
   * @returns {Function} Unsubscribe function
   */
  onRewardDelivered(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    this.rewardHandlers.push(callback);
    
    return () => {
      const index = this.rewardHandlers.indexOf(callback);
      if (index !== -1) {
        this.rewardHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Register callback for trial start events
   * @param {Function} callback - Event handler function
   * @returns {Function} Unsubscribe function
   */
  onTrialStart(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    this.trialHandlers.push(callback);
    
    return () => {
      const index = this.trialHandlers.indexOf(callback);
      if (index !== -1) {
        this.trialHandlers.splice(index, 1);
      }
    };
  }

  /**
   * Start a new trial
   * @param {Object} context - Trial context and metadata
   * @returns {Object} Trial start event
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
    this.trialHandlers.forEach(handler => {
      try {
        handler(trialEvent);
      } catch (error) {
        console.error('Trial handler error:', error);
      }
    });

    return trialEvent;
  }

  /**
   * End current trial
   * @param {Object} context - Trial end context
   * @returns {Object} Trial end event
   */
  endTrial(context = {}) {
    if (!this.trialStartTime) {
      throw new Error('No active trial to end');
    }

    const now = Date.now();
    const trialDuration = now - this.trialStartTime;
    const trialRewards = this.getCurrentTrialRewards();

    const trialEndEvent = {
      trialNumber: this.getCurrentTrialNumber(),
      startTime: this.trialStartTime,
      endTime: now,
      duration: trialDuration,
      rewardCount: trialRewards,
      context: { ...context }
    };

    this.trialStartTime = null;
    return trialEndEvent;
  }

  /**
   * Reset trial (start new trial immediately)
   * @returns {Object} New trial start event
   */
  resetTrial() {
    if (this.trialStartTime) {
      this.endTrial({ type: 'reset' });
    }
    return this.startTrial({ type: 'reset' });
  }

  /**
   * Get total reward count
   * @returns {number} Total rewards delivered
   */
  getRewardCount() {
    return this.rewardCount;
  }

  /**
   * Get current trial reward count
   * @returns {number} Rewards in current trial
   */
  getCurrentTrialRewards() {
    if (!this.trialStartTime) {
      return 0;
    }

    return this.rewardHistory.filter(reward => 
      reward.success !== false && reward.timestamp >= this.trialStartTime
    ).length;
  }

  /**
   * Get current trial number
   * @returns {number} Current trial number
   */
  getCurrentTrialNumber() {
    return this.trialCounter;
  }

  /**
   * Get current trial elapsed time
   * @returns {number} Trial time in milliseconds
   */
  getTrialTime() {
    if (!this.trialStartTime) {
      return 0;
    }
    return Date.now() - this.trialStartTime;
  }

  /**
   * Get session elapsed time
   * @returns {number} Session time in milliseconds
   */
  getSessionTime() {
    if (!this.sessionStartTime) {
      return 0;
    }
    return Date.now() - this.sessionStartTime;
  }

  /**
   * Get complete reward history
   * @returns {Array} Copy of reward history
   */
  getRewardHistory() {
    return [...this.rewardHistory];
  }

  /**
   * Get comprehensive reward statistics
   * @returns {Object} Detailed statistics object
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
      lastRewardTime: successfulRewards.length > 0 ? 
        successfulRewards[successfulRewards.length - 1].timestamp : null,
      currentTrialNumber: this.getCurrentTrialNumber()
    };
  }

  /**
   * Calculate average time between successful rewards
   * @returns {number|null} Average interval in milliseconds or null
   */
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
   * Get last successful reward event
   * @returns {Object|null} Last successful reward or null
   */
  getLastSuccessfulReward() {
    const successfulRewards = this.rewardHistory.filter(r => r.success !== false);
    return successfulRewards.length > 0 ? successfulRewards[successfulRewards.length - 1] : null;
  }

  /**
   * Request reward hardware from hardware manager
   * This is a placeholder that would typically interface with HardwareManager
   * @param {Object} config - Reward system configuration
   * @returns {Object} Reward wrapper instance
   */
  async requestRewardHardware(config) {
    // This would typically use dependency injection or service locator
    // For now, we'll simulate the hardware manager interface
    throw new Error('Reward hardware request not implemented - requires HardwareManager integration');
  }

  /**
   * Cleanup experiment resources
   */
  async cleanup() {
    try {
      // Stop reward system
      if (this.rewardWrapper && this.rewardWrapper.cleanup) {
        await this.rewardWrapper.cleanup();
      }
      
      // Clear handlers and data
      this.rewardHandlers = [];
      this.trialHandlers = [];
      this.isInitialized = false;
      this.rewardHandle = null;
      this.rewardWrapper = null;
      
      return true;
    } catch (error) {
      console.error('Cleanup error:', error);
      return false;
    }
  }
}