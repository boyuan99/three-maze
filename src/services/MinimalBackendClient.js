/**
 * MinimalBackendClient - Thin WebSocket client for Python backend
 *
 * A minimal "thin client" that only handles:
 * - WebSocket connection management
 * - Message sending/receiving
 * - Python experiment registration
 *
 * All hardware control and experiment logic is handled by Python experiments.
 * JavaScript only receives state updates and renders the visualization.
 *
 * Usage:
 *   const backend = new MinimalBackendClient();
 *   await backend.connect();
 *
 *   // Register Python experiment (Python does everything!)
 *   await backend.registerExperiment('hallway02', {
 *     port: 'COM5',
 *     baudRate: 115200,
 *     trialEndY: 70
 *   });
 *
 *   // Listen for state updates
 *   backend.on('experiment_state', (state) => {
 *     // Just update rendering
 *     updatePlayer(state.player.position);
 *     updateUI(state.experiment);
 *   });
 *
 *   // Cleanup
 *   await backend.unregisterExperiment('hallway02');
 *   await backend.disconnect();
 */

export class MinimalBackendClient {
  constructor(url = null) {
    this.url = url; // Will be set dynamically if null
    this.ws = null;
    this.connected = false;
    this.requestId = 0;

    // Map of requestId -> { resolve, reject, timeout }
    this.pendingRequests = new Map();

    // Map of event type -> array of handlers
    this.eventHandlers = new Map();

    // Request timeout
    this.requestTimeout = 5000; // ms

    // Logging
    this.debug = false; // Set to true for debug logs
  }

  // =========================================================================
  // CONNECTION MANAGEMENT
  // =========================================================================

  /**
   * Connect to the Python backend WebSocket server
   * @returns {Promise<void>}
   */
  async connect() {
    // If URL not provided, get WebSocket port from Electron
    if (!this.url) {
      try {
        const port = await window.electron.getWsPort();
        this.url = `ws://localhost:${port}`;
        this.log('Got WebSocket port from Electron:', port);
      } catch (error) {
        this.error('Failed to get WebSocket port from Electron, using default 8765');
        this.url = 'ws://localhost:8765';
      }
    }

    return new Promise((resolve, reject) => {
      this.log('Connecting to Python backend at', this.url);

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.log('WebSocket connected');
          this.connected = true;

          // Send initial connection message
          this.send('connect', {
            clientId: 'three-maze-renderer',
            version: '1.0.0'
          });

          resolve();
        };

        this.ws.onerror = (error) => {
          this.error('WebSocket error:', error);

          if (!this.connected) {
            reject(new Error('Failed to connect to Python backend'));
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = () => {
          this.log('WebSocket closed');
          this.connected = false;

          // Reject all pending requests
          for (const [id, request] of this.pendingRequests.entries()) {
            clearTimeout(request.timeout);
            request.reject(new Error('Connection closed'));
          }
          this.pendingRequests.clear();
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the Python backend
   * @returns {Promise<void>}
   */
  disconnect() {
    return new Promise((resolve) => {
      if (!this.ws || !this.connected) {
        resolve();
        return;
      }

      this.log('Disconnecting from Python backend');

      // Send disconnect message
      this.send('disconnect', {});

      // Close WebSocket
      this.ws.onclose = () => {
        this.connected = false;
        this.ws = null;
        resolve();
      };

      this.ws.close();
    });
  }

  // =========================================================================
  // MESSAGE HANDLING
  // =========================================================================

  /**
   * Handle incoming WebSocket message
   * @param {string} messageStr - Raw message string
   */
  handleMessage(messageStr) {
    try {
      const message = JSON.parse(messageStr);
      const { type, data, requestId } = message;

      this.log('Received:', type, requestId ? `(ID: ${requestId})` : '');

      // Handle response to a request
      if (requestId && this.pendingRequests.has(requestId)) {
        const request = this.pendingRequests.get(requestId);
        clearTimeout(request.timeout);
        this.pendingRequests.delete(requestId);

        // Check for errors
        if (type === 'error' || type.endsWith('_error')) {
          request.reject(new Error(data.error || 'Unknown error'));
        } else {
          request.resolve(data);
        }
        return;
      }

      // Handle event (broadcast to all handlers)
      this.emit(type, data);

    } catch (error) {
      this.error('Error handling message:', error);
    }
  }

  /**
   * Send a message to the backend (fire-and-forget)
   * @param {string} type - Message type
   * @param {Object} data - Message payload
   */
  send(type, data = {}) {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to backend');
    }

    const message = {
      type,
      data,
      timestamp: Date.now()
    };

    this.ws.send(JSON.stringify(message));
    this.log('Sent:', type);
  }

  /**
   * Send a request and wait for response
   * @param {string} type - Message type
   * @param {Object} data - Message payload
   * @returns {Promise<Object>} Response data
   */
  request(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        reject(new Error('Not connected to backend'));
        return;
      }

      const requestId = ++this.requestId;

      // Set up timeout
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, this.requestTimeout);

      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send request
      const message = {
        type,
        data,
        requestId,
        timestamp: Date.now()
      };

      this.ws.send(JSON.stringify(message));
      this.log('Request:', type, `(ID: ${requestId})`);
    });
  }

  /**
   * Register an event handler
   * @param {string} eventType - Event type to listen for
   * @param {Function} handler - Event handler function
   */
  on(eventType, handler) {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, []);
    }
    this.eventHandlers.get(eventType).push(handler);
  }

  /**
   * Unregister an event handler
   * @param {string} eventType - Event type
   * @param {Function} handler - Handler to remove
   */
  off(eventType, handler) {
    if (!this.eventHandlers.has(eventType)) return;

    const handlers = this.eventHandlers.get(eventType);
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
    }
  }

  /**
   * Emit an event to all registered handlers
   * @param {string} eventType - Event type
   * @param {Object} data - Event data
   */
  emit(eventType, data) {
    if (!this.eventHandlers.has(eventType)) return;

    const handlers = this.eventHandlers.get(eventType);
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        this.error('Error in event handler:', error);
      }
    }
  }

  // =========================================================================
  // EXPERIMENT CONTROL (Minimal)
  // =========================================================================

  /**
   * Register a Python experiment
   * The Python experiment will initialize its own hardware and manage state.
   *
   * @param {string} experimentId - Experiment ID (for backward compatibility)
   * @param {Object} config - Experiment configuration (may include 'filename' for dynamic loading)
   * @returns {Promise<Object>} Initial state from experiment
   */
  async registerExperiment(experimentId, config = {}) {
    this.log('Registering experiment:', config.filename || experimentId);

    const response = await this.request('experiment_register', {
      experimentId,
      filename: config.filename,  // NEW: Send filename for dynamic loading
      config
    });

    this.log('Experiment registered:', config.filename || experimentId, `(mode: ${response.hardwareMode})`);

    return response;
  }

  /**
   * Unregister the active Python experiment
   * The Python experiment will clean up its own hardware.
   *
   * @param {string} experimentId - Experiment ID
   * @returns {Promise<Object>} Final summary from experiment
   */
  async unregisterExperiment(experimentId) {
    this.log('Unregistering experiment:', experimentId);

    const response = await this.request('experiment_unregister', {
      experimentId
    });

    this.log('Experiment unregistered:', experimentId);

    return response;
  }

  /**
   * List available Python experiments
   * @returns {Promise<Array>} List of available experiments
   */
  async listExperiments() {
    const response = await this.request('experiment_list', {});
    return response.experiments || [];
  }

  // =========================================================================
  // DEBUGGING (Optional)
  // =========================================================================

  /**
   * Get backend status (for debugging)
   * @returns {Promise<Object>} Backend status
   */
  async getStatus() {
    return await this.request('status_request', {});
  }

  /**
   * Manual water delivery (for testing only)
   * Note: In production, water delivery should be handled by Python experiments.
   *
   * @param {number} amount - Number of pulses
   * @param {number} duration - Pulse duration in ms
   * @returns {Promise<Object>} Delivery result
   */
  async testWater(amount = 1, duration = 25) {
    this.log('Testing water delivery:', amount, 'pulses');
    return await this.request('water_deliver', { amount, duration });
  }

  // =========================================================================
  // LOGGING
  // =========================================================================

  log(...args) {
    if (this.debug) {
      console.log('[MinimalBackendClient]', ...args);
    }
  }

  error(...args) {
    console.error('[MinimalBackendClient]', ...args);
  }
}

export default MinimalBackendClient;
