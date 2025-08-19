/**
 * hallwaySerialMigrated.js
 * Migrated control logic from JsSerialHallwayScene.vue
 * 
 * Converted to function-based format to work with SerialCustomScene.vue loading system
 */

// Main experiment function expected by SerialCustomScene.vue
function serialHallwayExperiment() {
  // Begin header code - DO NOT EDIT
  const code = {};
  code.initialization = initializationCodeFun;
  code.runtime = runtimeCodeFun;
  code.termination = terminationCodeFun;
  // End header code - DO NOT EDIT

  return code;
}


// --- INITIALIZATION code: executes before the experiment engine starts.
async function initializationCodeFun(vr) {
  console.log('Initializing Hallway Serial Migration experiment...');

  // Physics constants
  vr.HALLWAY_LENGTH = 200;
  vr.HALLWAY_WIDTH = 20;
  vr.WALL_HEIGHT = 10;
  vr.WALL_THICKNESS = 1;
  vr.BLUE_SEGMENT_LENGTH = 30;
  vr.PLAYER_RADIUS = 0.5;
  vr.MAX_LINEAR_VELOCITY = 100;
  vr.DT = 1/20;

  // Initialize position and state
  vr.position = [0, 0, vr.PLAYER_RADIUS, 0]; // [x, y, z, theta]
  vr.velocity = [0, 0, 0, 0];
  vr.isActive = true;
  vr.serialData = null;
  vr.lastUpdateTime = Date.now();
  vr.trialStartTime = Date.now();
  vr.trialCount = 0;

  // Set up hardware connections
  vr.hardwareStatus = {
    serial: 'none',
    water: 'none',
    errors: []
  };

  if (typeof window === 'undefined' || !window.electron) {
    console.log('Running in simulation mode - no Electron environment');
    return vr;
  }

  // Request serial port via new hardware manager
  const serialResult = await window.electron.requestHardware('serial-port', {
    port: 'COM5',
    baudRate: 115200,
    autoOpen: true
  });

  if (serialResult.success) {
    vr.serialHandle = serialResult.handle;
    vr.hardwareStatus.serial = 'connected';
    console.log('Serial port connected via hardware manager');
    
    // Set up data handler via communication1 channel
    if (typeof window !== 'undefined' && window.electron && window.electron.onCommunication1) {
      window.electron.onCommunication1((data) => {
        // Receive parsed serial data and store for runtime processing
        vr.serialData = data;
        console.log('Received serial data:', data);
      });
      console.log('Serial data handler set up via communication1');
    } else {
      console.warn('Communication1 channel not available');
    }
  } else {
    throw new Error(`Serial port initialization failed: ${serialResult.error}`);
  }

  // Try water delivery (non-critical)
  const waterResult = await window.electron.requestHardware('water-delivery', {
    cooldownMs: 1000,
    testMode: false
  });

  if (waterResult.success) {
    vr.waterHandle = waterResult.handle;
    vr.hardwareStatus.water = 'available';
    console.log('Water delivery: Available');
  } else {
    vr.hardwareStatus.water = 'unavailable';
    console.log('Water delivery: Not available');
  }

  console.log('Experiment initialization complete');
  return vr;
}

// --- RUNTIME code: executes on every iteration of the experiment engine.
function runtimeCodeFun(vr) {
  // Check if experiment is active
  if (!vr.isActive || vr.error) return vr;

  // Process serial data if available
  if (vr.serialData) {
    try {
      // Convert displacement to velocity by dividing by DT
      const vx = Math.min(Math.max((parseFloat(vr.serialData.x) || 0) * 0.0364 / vr.DT, -vr.MAX_LINEAR_VELOCITY), vr.MAX_LINEAR_VELOCITY);
      const vy = Math.min(Math.max((parseFloat(vr.serialData.y) || 0) * 0.0364 / vr.DT, -vr.MAX_LINEAR_VELOCITY), vr.MAX_LINEAR_VELOCITY);

      // Calculate world velocities based on current orientation
      const worldVx = vx * Math.cos(vr.position[3]) - vy * Math.sin(vr.position[3]);
      const worldVz = -vx * Math.sin(vr.position[3]) - vy * Math.cos(vr.position[3]);

      // Set velocity
      vr.velocity = [worldVx, worldVz, vr.velocity[2], 0];

      // Handle rotation separately (direct angle control)
      const deltaTheta = (parseFloat(vr.serialData.theta) || 0) * 0.05;
      vr.position[3] += deltaTheta;

      // Update position based on velocity
      vr.position[0] += vr.velocity[0] * vr.DT;
      vr.position[1] += vr.velocity[1] * vr.DT;

      // Log experimental data (works with both new and legacy approaches)
      if (typeof window !== 'undefined' && window.electron) {
        const timestamp = vr.serialData.timestamp || Date.now();
        const logData = {
          timestamp: timestamp,
          x: vr.position[0].toFixed(3),
          y: (-vr.position[1]).toFixed(3),  // Flip Y coordinate for consistency
          theta: vr.position[3].toFixed(3),
          input_x: vr.serialData.x || 0,
          input_y: vr.serialData.y || 0,
          water: vr.serialData.water ? 1 : 0,
          trial_time: (timestamp - (vr.trialStartTime || timestamp)) / 1000
        };
        
        // Log as both structured data and TSV format
        const tsvLine = `${logData.timestamp}\t${logData.x}\t${logData.y}\t${logData.theta}\t${logData.input_x}\t${logData.input_y}\t${logData.water}\t${logData.trial_time}\n`;
        
        // Simple logging - use console as reliable fallback
        console.log('EXPERIMENT_DATA:', tsvLine.trim());
        
        // Try to send to Electron if available (but don't fail if it doesn't work)
        window.electron.invoke('log-experiment-data', logData).catch(() => {
          window.electron.sendMessage('experiment-log', tsvLine).catch(() => {
            // Already logged to console above
          });
        });
      }

      // Clear processed serial data
      vr.serialData = null;

      // Check trial end condition
      if (Math.abs(vr.position[1]) >= 70) {
        console.log('Trial reset due to Y position limit');
        
        // Reset position and start new trial
        vr.position = [0, 0, vr.PLAYER_RADIUS, 0];
        vr.velocity = [0, 0, 0, 0];
        vr.trialStartTime = Date.now();
        vr.trialCount += 1;
        
        // Deliver reward
        deliverReward(vr);
        console.log(`Reward delivered - Trial ${vr.trialCount} completed`);
      }
      
    } catch (err) {
      console.error('Error processing serial data:', err);
    }
  }

  return vr;
}

// --- TERMINATION code: executes after the experiment engine stops.
async function terminationCodeFun(vr) {
  console.log("EXPERIMENT TERMINATED");

  // Clean up hardware resources
  const cleanupResults = [];

  if (typeof window !== 'undefined' && window.electron) {
    // Release new architecture resources
    if (vr.serialHandle) {
      const result = await window.electron.releaseHardware(vr.serialHandle);
      cleanupResults.push(result.success ? 'Serial released' : 'Serial release failed');
    }
    
    if (vr.waterHandle) {
      const result = await window.electron.releaseHardware(vr.waterHandle);
      cleanupResults.push(result.success ? 'Water delivery released' : 'Water delivery release failed');
    }
    
    // No legacy cleanup needed
  }

  console.log('Cleanup complete:', cleanupResults.join(', '));

  vr.isActive = false;
  return vr;
}

// --- HELPER FUNCTIONS ---

// Deliver water reward
async function deliverReward(vr) {
  if (typeof window !== 'undefined' && window.electron) {
    console.log('Water reward delivered');
    window.electron.sendMessage('reward-delivered').catch(() => {
      console.log('Reward delivery notification failed (continuing anyway)');
    });
  } else {
    console.log('Water reward (simulation mode)');
  }
  return vr;
}

// Export the experiment (for Node.js environments)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = serialHallwayExperiment;
}
