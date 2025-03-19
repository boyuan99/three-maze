// User friendly scene controller template
// You can copy this file and fill in own logic, without needing to understand the underlying IPC communication

import { SceneController } from '../scene-controller.js'

export class TemplateController extends SceneController {
  constructor(options = {}) {
    super(options)

    // You can add your own state variables here
    this.userData = {
      // Example: cumulative reward count
      rewardCount: 0,

      // Example: trial start time
      startTime: null,

      // Example: current position
      position: { x: 0, y: 0, z: 0 },

      // Example: add your own state...
      myCustomState: null
    }

    // Default configuration
    this.config = {
      // Example: update rate (ms)
      updateRate: options.updateRate || 100,

      // Example: log enabled
      logEnabled: options.logEnabled !== false,

      // You can add your own configuration here...
      myCustomConfig: options.myCustomConfig || 'default'
    }
  }

  // ======================================================================
  // You should implement the following three methods: onInitialize, onUpdate and onDispose
  // ======================================================================

  /**
   * Initialize function: This function is called once when the scene is loaded
   * 
   * Suitable for:
   * - Initialize hardware connections
   * - Create data files
   * - Set initial state
   * - Other one-time setup work
   */
  async onInitialize() {
    console.log('Template controller initializing...')

    // Record start time
    this.userData.startTime = Date.now()

    // TODO: Add your initialization code here

    // Example: Notify the frontend that initialization is complete
    this.sendToScene('controller-ready', {
      timestamp: Date.now()
    })

    console.log('Template controller initialized')
  }

  /**
   * Update function: This function is called periodically according to the configured frequency
   * 
   * Suitable for:
   * - Read sensor data
   * - Update position information
   * - Check conditions and trigger events
   * - Other work that needs to be done regularly
   */
  async onUpdate() {
    // TODO: Add your update code here

    // Example: Simulate position update
    this.userData.position = {
      x: Math.random() * 10 - 5,
      y: 0,
      z: Math.random() * 10 - 5
    }

    // Example: Send updated position to frontend
    this.sendToScene('position-update', this.userData.position)

    // Example: Check if a reward should be delivered
    if (this.shouldDeliverReward()) {
      this.deliverReward()
    }
  }

  /**
   * Disposal function: This function is called once when the scene is closed
   * 
   * Suitable for:
   * - Close hardware connections
   * - Save data and logs
   * - Clean up resources
   * - Record summary information of the trial
   */
  async onDispose() {
    console.log('Template controller disposing...')

    // Calculate trial duration
    const duration = (Date.now() - this.userData.startTime) / 1000

    // TODO: Add your cleanup code here

    // Example: Record trial summary
    console.log(`Trial summary:`)
    console.log(`- Duration: ${duration} seconds`)
    console.log(`- Total rewards: ${this.userData.rewardCount}`)

    console.log('Template controller disposed')
  }

  // ======================================================================
  // The following are some helper methods that users can use
  // ======================================================================

  /**
   * Determine if a reward should be delivered
   * Users can modify this method according to their own logic
   */
  shouldDeliverReward() {
    // Example: Randomly decide whether to deliver a reward (probability of 1%)
    return Math.random() < 0.01
  }

  /**
   * Deliver a reward
   * This method provides a standard way to handle rewards
   */
  deliverReward() {
    // Increase reward count
    this.userData.rewardCount++

    console.log(`Delivering reward #${this.userData.rewardCount}`)

    // TODO: 在这里添加控制硬件给水的代码

    // Example: Notify the frontend about the reward event
    this.sendToScene('reward-delivered', {
      count: this.userData.rewardCount,
      timestamp: Date.now()
    })
  }

  /**
   * Record data
   * Convenient for users to record experimental data
   */
  logData(data) {
    if (!this.config.logEnabled) return

    // TODO: Add your data recording logic here

    console.log('Logged data:', data)
  }

  /**
   * Reset position
   * Reset the position of the animal/player
   */
  resetPosition() {
    console.log('Resetting position')

    // Reset position state
    this.userData.position = { x: 0, y: 0, z: 0 }

    // TODO: Add your logic for resetting position here

    // Notify the frontend
    this.sendToScene('position-reset', {
      timestamp: Date.now(),
      position: this.userData.position
    })
  }
} 