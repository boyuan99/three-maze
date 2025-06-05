/**
 * serialHallwayExperiment.js
 * Code for the Three-Maze experiment serialHallway.
 * 
 * This file implements the functionality of NewSerialHallwayScene.vue
 * integrated with Electron IPC
 */

// Import electron modules if possible (for type checking)
// In actual usage, these will be accessed via window.electron
let electron;

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
  console.log('Initializing serialHallway experiment');

  // Constants for hallway
  vr.HALLWAY_LENGTH = 200;
  vr.HALLWAY_WIDTH = 40;
  vr.WALL_HEIGHT = 10;
  vr.WALL_THICKNESS = 1;
  vr.BLUE_SEGMENT_LENGTH = 30;
  vr.PLAYER_RADIUS = 0.5;
  vr.MAX_LINEAR_VELOCITY = 100;
  vr.DT = 1 / 20; // 20Hz sampling rate
  vr.FALL_RESET_TIME = 5000;

  // Initialize position and state
  vr.position = [0, 0, vr.PLAYER_RADIUS, 0]; // [x, y, z, theta]
  vr.fallStartTime = null;
  vr.isActive = true;
  vr.endy = 70; // End position threshold 
  vr.water = 0;
  vr.numrewards = 0;

  // Initialize trial flags
  vr.isTrialStart = true;
  vr.isTrialEnd = false;
  vr.serialData = null;

  // Set up serial connection via IPC
  try {
    // Get reference to electron API
    electron = window.electron;

    // Initialize serial connection through main process
    const result = await electron.initializeJsSerial();
    if (result.error) {
      console.error('Serial initialization failed:', result.error);
      vr.error = result.error;
      return vr;
    }

    console.log('Serial connection initialized via IPC');

    // Set up serial data handler
    electron.onSerialData((data) => {
      vr.serialData = data;
      console.log('Experiment received serial data:', data);
    });

  } catch (err) {
    console.error('Error in initialization:', err);
    vr.error = err.message;
  }

  console.log('Experiment initialization complete');
  return vr;
}

// --- RUNTIME code: executes on every iteration of the experiment engine.
function runtimeCodeFun(vr) {
  // Check if experiment is active
  if (!vr.isActive || vr.error) return vr;

  // Process serial data
  if (vr.serialData) {
    try {
      // Convert displacement to velocity by dividing by DT
      const vx = Math.min(Math.max((parseFloat(vr.serialData.x) || 0) * 0.0364 / vr.DT, -vr.MAX_LINEAR_VELOCITY), vr.MAX_LINEAR_VELOCITY);
      const vy = Math.min(Math.max((parseFloat(vr.serialData.y) || 0) * 0.0364 / vr.DT, -vr.MAX_LINEAR_VELOCITY), vr.MAX_LINEAR_VELOCITY);

      // Calculate world velocities based on current orientation
      const worldVx = vx * Math.cos(vr.position[3]) - vy * Math.sin(vr.position[3]);
      const worldVz = -vx * Math.sin(vr.position[3]) - vy * Math.cos(vr.position[3]);

      // Check if player is falling
      if (vr.fallStartTime) {
        // If falling, only preserve vertical velocity and stop rotation
        vr.velocity = [0, 0, vr.velocity[2], 0];
      } else {
        // Normal movement when not falling
        vr.velocity = [worldVx, worldVz, vr.velocity[2], 0];

        // Handle rotation separately (direct angle control)
        const deltaTheta = (parseFloat(vr.serialData.theta) || 0) * 0.05;
        vr.position[3] += deltaTheta;
      }

      // Update position based on velocity
      vr.position[0] += vr.velocity[0] * vr.dt;
      vr.position[1] += vr.velocity[1] * vr.dt;

      // Log data via IPC
      const logData = `${vr.position[0].toFixed(3)}\t${-vr.position[1].toFixed(3)}\t${vr.position[3].toFixed(3)}\t${vr.serialData.x || 0}\t${vr.serialData.y || 0}\t${vr.serialData.water ? 1 : 0}\t${vr.serialData.timestamp}\n`;
      electron.appendToLog(logData);

      // Clear processed serial data
      vr.serialData = null;

      // Fall detection
      if (vr.position[2] < vr.PLAYER_RADIUS && !vr.fallStartTime) {
        vr.fallStartTime = Date.now();
      } else if (vr.position[2] >= vr.PLAYER_RADIUS) {
        vr.fallStartTime = null;
      }

      // Reset after fall timeout
      if (vr.fallStartTime && (Date.now() - vr.fallStartTime > vr.FALL_RESET_TIME)) {
        vr.position = [0, 0, vr.PLAYER_RADIUS, 0];
        vr.velocity = [0, 0, 0, 0];
        vr.fallStartTime = null;
        console.log('Reset position due to fall timeout');
      }

      // Check trial end condition
      if (Math.abs(vr.position[1]) >= vr.endy) {
        vr.isTrialEnd = true;
      }
    } catch (err) {
      console.error('Error processing serial data:', err);
    }
  }

  // Handle trial end
  if (vr.isTrialEnd) {
    // Reset position
    vr.position = [0, 0, vr.PLAYER_RADIUS, 0];
    vr.velocity = [0, 0, 0, 0];
    vr.isTrialEnd = false;
    vr.isTrialStart = true;

    // Deliver reward via IPC
    deliverReward(vr);
    vr.numrewards++;
    console.log(`Reward delivered: ${vr.numrewards}`);
  }

  return vr;
}

// --- TERMINATION code: executes after the experiment engine stops.
async function terminationCodeFun(vr) {
  console.log("EXPERIMENT TERMINATED");
  console.log(`Total rewards: ${vr.numrewards}`);

  // Close serial connection via IPC
  try {
    if (electron) {
      await electron.closeJsSerial();
      console.log('Serial connection closed via IPC');
    }
  } catch (err) {
    console.error('Error closing serial connection:', err);
  }

  // Clear active flag
  vr.isActive = false;

  return vr;
}

// --- HELPER FUNCTIONS ---

// Use IPC to deliver water reward
async function deliverReward(vr) {
  try {
    if (electron) {
      const result = await electron.deliverWater();
      if (result.error) {
        console.error('Water delivery failed:', result.error);
      } else {
        console.log('Water delivered successfully');
        // Notify main process about reward delivery
        electron.sendMessage('reward-delivered');
      }
    }
  } catch (err) {
    console.error('Error in water delivery:', err);
  }
  return vr;
}

// Export the experiment
module.exports = serialHallwayExperiment;