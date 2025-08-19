/**
 * hallwayControlTemplate.js
 * Template control file for Three-Maze custom scenes.
 * 
 * This file implements the functionality for SerialCustomScene.vue
 * integrated with JSON scene configurations and Electron IPC
 */

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
  console.log('Initializing hallway experiment with custom scene');

  // Constants for hallway (these can be overridden by scene config)
  vr.HALLWAY_LENGTH = vr.HALLWAY_LENGTH || 200;
  vr.HALLWAY_WIDTH = vr.HALLWAY_WIDTH || 40;
  vr.WALL_HEIGHT = vr.WALL_HEIGHT || 10;
  vr.WALL_THICKNESS = vr.WALL_THICKNESS || 1;
  vr.BLUE_SEGMENT_LENGTH = vr.BLUE_SEGMENT_LENGTH || 30;
  vr.PLAYER_RADIUS = vr.PLAYER_RADIUS || 0.5;
  vr.MAX_LINEAR_VELOCITY = vr.MAX_LINEAR_VELOCITY || 100;
  vr.DT = vr.DT || 1 / 20; // 20Hz sampling rate
  vr.FALL_RESET_TIME = vr.FALL_RESET_TIME || 5000;

  // Initialize position and state
  vr.position = [0, 0, vr.PLAYER_RADIUS, 0]; // [x, y, z, theta]
  vr.velocity = [0, 0, 0, 0];
  vr.fallStartTime = null;
  vr.isActive = true;
  vr.endy = vr.endy || 70; // End position threshold 
  vr.water = 0;
  vr.numrewards = 0;

  // Initialize trial flags
  vr.isTrialStart = true;
  vr.isTrialEnd = false;
  vr.serialData = null;

  // For now, we'll run without hardware to fix the module loading issues
  // TODO: Implement hardware integration once the new architecture is fully ready
  try {
    if (typeof window !== 'undefined' && window.electron) {
      console.log('Electron environment detected, but running without hardware for now');
      // Future hardware setup will go here
    } else {
      console.log('Not in Electron environment - running in simulation mode');
    }
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

  // For now, simulate basic movement without serial data
  // TODO: Restore serial data processing once hardware is integrated
  
  // Simple keyboard-like simulation for testing
  if (typeof window !== 'undefined') {
    // Add some basic movement simulation
    const now = Date.now();
    if (!vr.lastUpdateTime) vr.lastUpdateTime = now;
    const deltaTime = (now - vr.lastUpdateTime) / 1000; // Convert to seconds
    vr.lastUpdateTime = now;
    
    // Very basic movement simulation - oscillate forward and backward
    const oscillationSpeed = 0.1;
    const oscillation = Math.sin(now * oscillationSpeed * 0.001) * 10;
    vr.position[1] = oscillation;
    
    // Check trial end condition
    if (Math.abs(vr.position[1]) >= vr.endy) {
      vr.isTrialEnd = true;
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

  // Hardware cleanup will be implemented when hardware integration is added
  try {
    if (typeof window !== 'undefined' && window.electron) {
      console.log('Experiment cleanup completed');
    }
  } catch (err) {
    console.error('Error in cleanup:', err);
  }

  // Clear active flag
  vr.isActive = false;

  return vr;
}

// --- HELPER FUNCTIONS ---

// Simulate water reward for now
async function deliverReward(vr) {
  try {
    if (typeof window !== 'undefined' && window.electron) {
      console.log('Water delivery simulated');
      // Notify main process about reward delivery for logging
      window.electron.sendMessage('reward-delivered');
    } else {
      console.log('Water delivery requested (simulation mode)');
    }
  } catch (err) {
    console.error('Error in water delivery simulation:', err);
  }
  return vr;
}

// Export the experiment (for Node.js environments)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = serialHallwayExperiment;
} 