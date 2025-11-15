/**
 * useBackend - Vue composable for BackendClient integration
 *
 * Provides a clean API for Vue components to interact with the Python backend.
 * Handles connection lifecycle, event subscriptions, and cleanup.
 *
 * Usage:
 *   const { backend, connected, serialData, error } = useBackend()
 *
 *   onMounted(async () => {
 *     await backend.connect()
 *     await backend.initSerial({ port: 'COM5', baudRate: 115200 })
 *   })
 */

import { ref, onUnmounted, reactive } from 'vue'
import { backend as globalBackend } from '../services/BackendClient.js'

/**
 * Create a new useBackend instance
 * @param {object} options - Configuration options
 * @param {boolean} options.autoConnect - Auto-connect on mount (default: false)
 * @param {boolean} options.useGlobalInstance - Use global backend instance (default: true)
 * @returns {object} Backend composable
 */
export function useBackend(options = {}) {
  const {
    autoConnect = false,
    useGlobalInstance = true
  } = options

  // Use global instance or create a new one
  const backend = useGlobalInstance ? globalBackend : new BackendClient()

  // Reactive state
  const connected = ref(backend.isConnected())
  const reconnecting = ref(false)
  const error = ref(null)

  // Serial data (most commonly used)
  const serialData = ref(null)

  // Hardware state
  const hardwareState = reactive({
    serialHandle: null,
    logHandle: null,
    waterDeliveryCount: 0,
    lastWaterDelivery: null
  })

  // Experiment state
  const experimentState = reactive({
    experimentId: null,
    sessionId: null,
    startTime: null,
    running: false
  })

  // Event handlers that need cleanup
  const eventHandlers = []

  /**
   * Register an event handler and track it for cleanup
   * @param {string} type - Event type
   * @param {function} handler - Event handler
   */
  function on(type, handler) {
    backend.on(type, handler)
    eventHandlers.push({ type, handler })
  }

  /**
   * Set up default event listeners
   */
  function setupListeners() {
    // Connection events
    on('connected', (data) => {
      connected.value = true
      reconnecting.value = false
      error.value = null
      console.log('[useBackend] Connected to backend:', data)
    })

    on('disconnected', (data) => {
      connected.value = false
      console.log('[useBackend] Disconnected from backend:', data)
      if (data.willReconnect) {
        reconnecting.value = true
      }
    })

    on('reconnecting', (data) => {
      reconnecting.value = true
      console.log(`[useBackend] Reconnecting (${data.attempt}/${data.maxAttempts})`)
    })

    on('reconnect_failed', (data) => {
      reconnecting.value = false
      error.value = 'Failed to reconnect to backend'
      console.error('[useBackend] Reconnection failed:', data)
    })

    // Serial data (high frequency - update ref)
    on('serial_data', (data) => {
      serialData.value = data
    })

    // Serial events
    on('serial_initialized', (data) => {
      hardwareState.serialHandle = data.handle
      console.log('[useBackend] Serial initialized:', data)
    })

    on('serial_closed', (data) => {
      hardwareState.serialHandle = null
      console.log('[useBackend] Serial closed:', data)
    })

    on('serial_error', (data) => {
      error.value = data.error
      console.error('[useBackend] Serial error:', data)
    })

    // Water delivery events
    on('water_delivered', (data) => {
      hardwareState.waterDeliveryCount = data.deliveryCount
      hardwareState.lastWaterDelivery = data
      console.log('[useBackend] Water delivered:', data)
    })

    on('water_rate_limited', (data) => {
      console.warn('[useBackend] Water delivery rate limited:', data)
    })

    // Logging events
    on('logging_started', (data) => {
      hardwareState.logHandle = data.handle
      console.log('[useBackend] Logging started:', data)
    })

    on('logging_stopped', (data) => {
      hardwareState.logHandle = null
      console.log('[useBackend] Logging stopped:', data)
    })

    // Experiment events
    on('experiment_started', (data) => {
      experimentState.experimentId = data.experimentId
      experimentState.sessionId = data.sessionId
      experimentState.startTime = data.startTime
      experimentState.running = true
      console.log('[useBackend] Experiment started:', data)
    })

    on('experiment_stopped', (data) => {
      experimentState.running = false
      console.log('[useBackend] Experiment stopped:', data)
    })

    // Error events
    on('error', (data) => {
      error.value = data.message
      console.error('[useBackend] Backend error:', data)
    })
  }

  /**
   * Connect to backend
   */
  async function connect() {
    try {
      await backend.connect()
      return true
    } catch (err) {
      error.value = err.message
      console.error('[useBackend] Connection failed:', err)
      return false
    }
  }

  /**
   * Disconnect from backend
   */
  async function disconnect() {
    try {
      await backend.disconnect()
      return true
    } catch (err) {
      error.value = err.message
      console.error('[useBackend] Disconnect failed:', err)
      return false
    }
  }

  /**
   * Initialize serial port with automatic error handling
   */
  async function initSerial(config) {
    try {
      const result = await backend.initSerial(config)
      return result
    } catch (err) {
      error.value = `Failed to initialize serial: ${err.message}`
      console.error('[useBackend] Serial init failed:', err)
      throw err
    }
  }

  /**
   * Close serial port
   */
  async function closeSerial() {
    if (!hardwareState.serialHandle) {
      console.warn('[useBackend] No serial port to close')
      return
    }

    try {
      const result = await backend.closeSerial(hardwareState.serialHandle)
      return result
    } catch (err) {
      error.value = `Failed to close serial: ${err.message}`
      console.error('[useBackend] Serial close failed:', err)
      throw err
    }
  }

  /**
   * Deliver water reward
   */
  async function deliverWater(config = {}) {
    try {
      const result = await backend.deliverWater(config)
      return result
    } catch (err) {
      error.value = `Failed to deliver water: ${err.message}`
      console.error('[useBackend] Water delivery failed:', err)
      throw err
    }
  }

  /**
   * Start data logging
   */
  async function startLogging(config) {
    try {
      const result = await backend.startLogging(config)
      return result
    } catch (err) {
      error.value = `Failed to start logging: ${err.message}`
      console.error('[useBackend] Logging start failed:', err)
      throw err
    }
  }

  /**
   * Write log entry (fire-and-forget)
   */
  function writeLog(entry) {
    if (!hardwareState.logHandle) {
      console.warn('[useBackend] No logging session active')
      return
    }

    try {
      backend.writeLog(hardwareState.logHandle, entry)
    } catch (err) {
      console.error('[useBackend] Log write failed:', err)
    }
  }

  /**
   * Stop data logging
   */
  async function stopLogging() {
    if (!hardwareState.logHandle) {
      console.warn('[useBackend] No logging session to stop')
      return
    }

    try {
      const result = await backend.stopLogging(hardwareState.logHandle)
      return result
    } catch (err) {
      error.value = `Failed to stop logging: ${err.message}`
      console.error('[useBackend] Logging stop failed:', err)
      throw err
    }
  }

  /**
   * Send position update
   */
  function sendPosition(position) {
    if (!connected.value) return

    try {
      backend.sendPosition(position)
    } catch (err) {
      console.error('[useBackend] Position send failed:', err)
    }
  }

  /**
   * Start experiment
   */
  async function startExperiment(config) {
    try {
      const result = await backend.startExperiment(config)
      return result
    } catch (err) {
      error.value = `Failed to start experiment: ${err.message}`
      console.error('[useBackend] Experiment start failed:', err)
      throw err
    }
  }

  /**
   * Stop experiment
   */
  async function stopExperiment(reason = 'user_requested') {
    if (!experimentState.experimentId) {
      console.warn('[useBackend] No experiment to stop')
      return
    }

    try {
      const result = await backend.stopExperiment(experimentState.experimentId, reason)
      return result
    } catch (err) {
      error.value = `Failed to stop experiment: ${err.message}`
      console.error('[useBackend] Experiment stop failed:', err)
      throw err
    }
  }

  /**
   * Get system status
   */
  async function getStatus(includeHardware = true, includeExperiment = true) {
    try {
      const result = await backend.getStatus(includeHardware, includeExperiment)
      return result
    } catch (err) {
      error.value = `Failed to get status: ${err.message}`
      console.error('[useBackend] Status request failed:', err)
      throw err
    }
  }

  /**
   * Clear error message
   */
  function clearError() {
    error.value = null
  }

  // Set up event listeners
  setupListeners()

  // Auto-connect if requested
  if (autoConnect) {
    connect()
  }

  // Cleanup on unmount
  onUnmounted(async () => {
    console.log('[useBackend] Component unmounting - cleaning up')

    // Remove all event handlers
    for (const { type, handler } of eventHandlers) {
      backend.off(type, handler)
    }
    eventHandlers.length = 0

    // Close hardware if still open
    if (hardwareState.serialHandle) {
      try {
        await closeSerial()
      } catch (err) {
        console.error('[useBackend] Failed to close serial on unmount:', err)
      }
    }

    if (hardwareState.logHandle) {
      try {
        await stopLogging()
      } catch (err) {
        console.error('[useBackend] Failed to stop logging on unmount:', err)
      }
    }

    // Stop experiment if running
    if (experimentState.running) {
      try {
        await stopExperiment('component_unmounted')
      } catch (err) {
        console.error('[useBackend] Failed to stop experiment on unmount:', err)
      }
    }

    // Only disconnect if not using global instance
    if (!useGlobalInstance) {
      await disconnect()
    }
  })

  return {
    // Backend instance
    backend,

    // Connection state
    connected,
    reconnecting,
    error,

    // Data streams
    serialData,

    // Hardware state
    hardwareState,

    // Experiment state
    experimentState,

    // Connection methods
    connect,
    disconnect,

    // Serial methods
    initSerial,
    closeSerial,

    // Water delivery
    deliverWater,

    // Logging methods
    startLogging,
    writeLog,
    stopLogging,

    // Position updates
    sendPosition,

    // Experiment methods
    startExperiment,
    stopExperiment,

    // Utility methods
    getStatus,
    clearError,

    // Event subscription (for custom events)
    on: (type, handler) => on(type, handler)
  }
}

export default useBackend
