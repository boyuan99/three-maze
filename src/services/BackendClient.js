/**
 * BackendClient - WebSocket client for Python backend communication
 *
 * Provides a clean API for frontend-backend communication over WebSocket.
 * Follows the protocol specified in .claude/WEBSOCKET_PROTOCOL.md
 *
 * Usage:
 *   const backend = new BackendClient();
 *   await backend.connect();
 *
 *   // Listen for events
 *   backend.on('serial_data', (data) => {
 *     console.log('Position:', data.x, data.y, data.theta);
 *   });
 *
 *   // Send commands (with response)
 *   await backend.initSerial({ port: 'COM5', baudRate: 115200 });
 *   await backend.deliverWater({ amount: 1, duration: 25 });
 *
 *   // Disconnect
 *   await backend.disconnect();
 */

export class BackendClient {
  constructor(url = 'ws://localhost:8765') {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.requestId = 0;

    // Map of requestId -> { resolve, reject, timeout }
    this.pendingRequests = new Map();

    // Map of event type -> array of handlers
    this.eventHandlers = new Map();

    // Connection management
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000; // ms
    this.reconnectTimer = null;
    this.shouldReconnect = true;

    // Heartbeat
    this.heartbeatInterval = null;
    this.heartbeatFrequency = 1000; // ms
    this.lastPongTime = null;
    this.heartbeatTimeout = 5000; // ms - consider disconnected if no pong

    // Request timeout
    this.requestTimeout = 5000; // ms

    // Logging
    this.debug = true; // Set to false to disable debug logs
  }

  /**
   * Connect to the Python backend WebSocket server
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.log('Connecting to Python backend at', this.url);

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.log('WebSocket connected');
          this.connected = true;
          this.reconnectAttempts = 0;
          this.lastPongTime = Date.now();

          // Start heartbeat
          this.startHeartbeat();

          // Send initial connection message
          this.send('connect', {
            clientId: 'electron-renderer',
            version: '1.0.0',
            capabilities: ['serial', 'water-delivery', 'data-logging']
          });

          resolve();
        };

        this.ws.onerror = (error) => {
          this.error('WebSocket error:', error);

          if (!this.connected) {
            // Connection failed initially
            reject(new Error('Failed to connect to Python backend'));
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = () => {
          this.log('WebSocket closed');
          this.connected = false;
          this.stopHeartbeat();

          // Reject all pending requests
          for (const [requestId, { reject, timeout }] of this.pendingRequests) {
            clearTimeout(timeout);
            reject(new Error('Connection closed'));
          }
          this.pendingRequests.clear();

          // Emit disconnect event
          this.emit('disconnected', {
            timestamp: Date.now(),
            willReconnect: this.shouldReconnect
          });

          // Attempt to reconnect
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        };

      } catch (error) {
        this.error('Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the Python backend
   * @param {string} reason - Reason for disconnection
   * @returns {Promise<void>}
   */
  async disconnect(reason = 'user_requested') {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws && this.connected) {
      // Send graceful disconnect message
      this.send('disconnect', { reason });

      // Wait a bit for message to send
      await new Promise(resolve => setTimeout(resolve, 100));

      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
  }

  /**
   * Schedule a reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.error('Max reconnection attempts reached');
      this.emit('reconnect_failed', {
        attempts: this.reconnectAttempts
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

    this.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.emit('reconnecting', {
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts
      });

      this.connect().catch(err => {
        this.error('Reconnection failed:', err);
      });
    }, delay);
  }

  /**
   * Start heartbeat (ping/pong)
   */
  startHeartbeat() {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      // Check if we've received a pong recently
      if (this.lastPongTime && (Date.now() - this.lastPongTime) > this.heartbeatTimeout) {
        this.error('Heartbeat timeout - no pong received');
        this.ws.close();
        return;
      }

      // Send ping
      this.send('ping', {});
    }, this.heartbeatFrequency);
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Handle incoming message from Python backend
   * @param {string} messageStr - JSON message string
   */
  handleMessage(messageStr) {
    try {
      const message = JSON.parse(messageStr);
      const { type, data, requestId, timestamp } = message;

      // Log incoming messages (except high-frequency ones)
      if (type !== 'serial_data' && type !== 'pong') {
        this.log('←', type, data);
      }

      // Handle pong (heartbeat response)
      if (type === 'pong') {
        this.lastPongTime = Date.now();
        return;
      }

      // Handle request/response pairing
      if (requestId && this.pendingRequests.has(requestId)) {
        const { resolve, timeout } = this.pendingRequests.get(requestId);
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);

        // Check if it's an error response
        if (type === 'error' || type.endsWith('_error')) {
          const error = new Error(data.message || 'Unknown error');
          error.code = data.code;
          error.data = data;
          this.emit('error', data);
          // Note: We still resolve with error data rather than reject
          // This allows callers to handle errors explicitly
        }

        resolve({ type, data, timestamp });
        return;
      }

      // Handle events (fire-and-forget messages)
      this.emit(type, data, timestamp);

    } catch (error) {
      this.error('Failed to parse message:', error, messageStr);
    }
  }

  /**
   * Send a message to Python backend (fire-and-forget)
   * @param {string} type - Message type
   * @param {object} data - Message data
   */
  send(type, data) {
    if (!this.ws || !this.connected) {
      this.error('Cannot send message - not connected');
      throw new Error('WebSocket not connected');
    }

    const message = {
      type,
      data,
      timestamp: Date.now()
    };

    // Log outgoing messages (except high-frequency ones)
    if (type !== 'ping' && type !== 'position_update') {
      this.log('→', type, data);
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send a request to Python backend and wait for response
   * @param {string} type - Message type
   * @param {object} data - Message data
   * @returns {Promise<{type: string, data: object, timestamp: number}>}
   */
  request(type, data) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const requestId = `req_${++this.requestId}`;

      // Set up timeout
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, this.requestTimeout);

      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send message
      const message = {
        type,
        data,
        requestId,
        timestamp: Date.now()
      };

      this.log('→', type, data, `(${requestId})`);
      this.ws.send(JSON.stringify(message));
    });
  }

  /**
   * Register an event handler
   * @param {string} type - Event type
   * @param {function} handler - Event handler function
   */
  on(type, handler) {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, []);
    }
    this.eventHandlers.get(type).push(handler);
  }

  /**
   * Unregister an event handler
   * @param {string} type - Event type
   * @param {function} handler - Event handler function to remove
   */
  off(type, handler) {
    if (!this.eventHandlers.has(type)) {
      return;
    }

    const handlers = this.eventHandlers.get(type);
    const index = handlers.indexOf(handler);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  }

  /**
   * Emit an event to all registered handlers
   * @param {string} type - Event type
   * @param {object} data - Event data
   * @param {number} timestamp - Event timestamp
   */
  emit(type, data, timestamp) {
    if (!this.eventHandlers.has(type)) {
      return;
    }

    const handlers = this.eventHandlers.get(type);
    for (const handler of handlers) {
      try {
        handler(data, timestamp);
      } catch (error) {
        this.error('Event handler error:', error);
      }
    }
  }

  // ========================================
  // Hardware Control Methods
  // ========================================

  /**
   * Initialize serial port
   * @param {object} config - Serial port configuration
   * @param {string} config.port - Port name (e.g., 'COM5')
   * @param {number} config.baudRate - Baud rate (default: 115200)
   * @param {boolean} config.autoStart - Auto-start data streaming (default: true)
   * @returns {Promise<{port: string, status: string, handle: string}>}
   */
  async initSerial(config) {
    const { port, baudRate = 115200, autoStart = true } = config;
    const response = await this.request('serial_init', {
      port,
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoStart
    });
    return response.data;
  }

  /**
   * Close serial port
   * @param {string} handle - Serial handle from initSerial
   * @returns {Promise<{handle: string, status: string}>}
   */
  async closeSerial(handle) {
    const response = await this.request('serial_close', { handle });
    return response.data;
  }

  /**
   * Deliver water reward
   * @param {object} config - Water delivery configuration
   * @param {number} config.amount - Amount (unitless, typically 1)
   * @param {number} config.duration - Duration in milliseconds (default: 25)
   * @param {string} config.channel - DAQ channel (default: 'Dev1/ao0')
   * @returns {Promise<{amount: number, duration: number, actualDuration: number, deliveryCount: number}>}
   */
  async deliverWater(config) {
    const { amount = 1, duration = 25, channel = 'Dev1/ao0' } = config;
    const response = await this.request('water_deliver', {
      amount,
      duration,
      channel
    });
    return response.data;
  }

  /**
   * Start data logging
   * @param {object} config - Logging configuration
   * @param {string} config.filename - Log filename
   * @param {string} config.format - File format ('tsv', 'csv', 'json')
   * @param {boolean} config.includeHeaders - Include column headers (default: true)
   * @param {string} config.logPath - Log directory (default: 'logs')
   * @returns {Promise<{filename: string, fullPath: string, handle: string}>}
   */
  async startLogging(config) {
    const {
      filename,
      format = 'tsv',
      includeHeaders = true,
      logPath = 'logs',
      bufferSize = 100
    } = config;

    const response = await this.request('logging_start', {
      filename,
      format,
      includeHeaders,
      logPath,
      bufferSize
    });
    return response.data;
  }

  /**
   * Write log entry
   * @param {string} handle - Log handle from startLogging
   * @param {object} entry - Log entry data
   */
  writeLog(handle, entry) {
    // Fire-and-forget - no response expected
    this.send('logging_write', { handle, entry });
  }

  /**
   * Stop data logging
   * @param {string} handle - Log handle from startLogging
   * @returns {Promise<{handle: string, totalEntries: number, fileSize: number, duration: number}>}
   */
  async stopLogging(handle) {
    const response = await this.request('logging_stop', { handle });
    return response.data;
  }

  /**
   * Start experiment
   * @param {object} config - Experiment configuration
   * @param {string} config.experimentId - Experiment identifier
   * @param {string} config.experimentType - Experiment type (e.g., 'hallway')
   * @param {object} config.config - Experiment-specific configuration
   * @returns {Promise<{experimentId: string, sessionId: string, startTime: number}>}
   */
  async startExperiment(config) {
    const response = await this.request('experiment_start', config);
    return response.data;
  }

  /**
   * Stop experiment
   * @param {string} experimentId - Experiment identifier
   * @param {string} reason - Reason for stopping (default: 'user_requested')
   * @returns {Promise<{experimentId: string, sessionId: string, duration: number, trialsCompleted: number}>}
   */
  async stopExperiment(experimentId, reason = 'user_requested') {
    const response = await this.request('experiment_stop', {
      experimentId,
      reason
    });
    return response.data;
  }

  /**
   * Send position update to backend
   * @param {object} position - Position data
   * @param {number} position.x - X coordinate
   * @param {number} position.y - Y coordinate
   * @param {number} position.z - Z coordinate
   * @param {number} position.theta - Rotation angle
   * @param {object} position.velocity - Velocity vector (optional)
   */
  sendPosition(position) {
    // Fire-and-forget - no response expected
    this.send('position_update', position);
  }

  /**
   * Request system status
   * @param {boolean} includeHardware - Include hardware status (default: true)
   * @param {boolean} includeExperiment - Include experiment status (default: true)
   * @returns {Promise<{system: object, hardware: object, experiment: object}>}
   */
  async getStatus(includeHardware = true, includeExperiment = true) {
    const response = await this.request('status_request', {
      includeHardware,
      includeExperiment
    });
    return response.data;
  }

  // ========================================
  // Utility Methods
  // ========================================

  /**
   * Check if connected to backend
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Get connection state
   * @returns {object}
   */
  getState() {
    return {
      connected: this.connected,
      reconnectAttempts: this.reconnectAttempts,
      pendingRequests: this.pendingRequests.size,
      lastPongTime: this.lastPongTime
    };
  }

  /**
   * Enable/disable debug logging
   * @param {boolean} enabled
   */
  setDebug(enabled) {
    this.debug = enabled;
  }

  /**
   * Log debug message
   */
  log(...args) {
    if (this.debug) {
      console.log('[BackendClient]', ...args);
    }
  }

  /**
   * Log error message
   */
  error(...args) {
    console.error('[BackendClient]', ...args);
  }
}

// Export singleton instance for convenience
export const backend = new BackendClient();

// Also export the class for custom instances
export default BackendClient;
