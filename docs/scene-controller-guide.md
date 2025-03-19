# Scene Controller Guide

This guide explains how to use the Three-Maze scene controller system to create and manage backend logic for custom scenes.

## Overview

Scene controllers are responsible for managing the backend logic of scenes, such as:
- Hardware communication (e.g., serial ports, sensors)
- Position tracking and updates
- Reward delivery logic
- Data recording and analysis

Each scene can have its own controller, responsible for behaviors and logic specific to that scene. Controllers run in the Electron main process and communicate with the frontend scene via IPC.

## Using Scene Controllers

### 1. Creating a Custom Controller

The simplest method is to copy the template file:

1. Copy the `electron/scripts/controllers/template-controller.js` file
2. Rename it to describe your scene, e.g., `my-experiment-controller.js`
3. Implement three key methods:
   - `onInitialize()` - Called once when the scene loads
   - `onUpdate()` - Called periodically based on the set frequency
   - `onDispose()` - Called once when the scene closes

### 2. Controller Example

Here's an example of a simple custom controller:

```javascript
import { SceneController } from '../scene-controller.js'

export class MyExperimentController extends SceneController {
  constructor(options = {}) {
    super(options)
    
    // Custom state
    this.userData = {
      rewardCount: 0,
      startTime: null,
      position: { x: 0, y: 0, z: 0 }
    }
    
    // Custom configuration
    this.config = {
      updateRate: options.updateRate || 100,
      targetRadius: options.targetRadius || 0.5
    }
  }
  
  // Initialization function
  async onInitialize() {
    console.log('Experiment initialization started...')
    
    this.userData.startTime = Date.now()
    
    // Notify frontend that initialization is complete
    this.sendToScene('controller-ready', {
      timestamp: Date.now()
    })
  }
  
  // Update function
  async onUpdate() {
    // Read position data (example uses random data)
    this.userData.position = {
      x: Math.random() * 10 - 5,
      y: 0,
      z: Math.random() * 10 - 5
    }
    
    // Send position to frontend
    this.sendToScene('position-update', this.userData.position)
    
    // Determine if reward should be given
    if (this.isNearTarget(this.userData.position)) {
      this.deliverReward()
    }
  }
  
  // Disposal function
  async onDispose() {
    const duration = (Date.now() - this.userData.startTime) / 1000
    
    console.log(`Experiment ended!`)
    console.log(`- Duration: ${duration} seconds`)
    console.log(`- Total rewards: ${this.userData.rewardCount}`)
  }
  
  // Custom helper methods
  isNearTarget(position) {
    // Determine if close to target position
    const distance = Math.sqrt(position.x * position.x + position.z * position.z)
    return distance < this.config.targetRadius
  }
  
  // Reward method
  deliverReward() {
    this.userData.rewardCount++
    
    console.log(`Reward delivered #${this.userData.rewardCount}`)
    
    // Notify frontend
    this.sendToScene('reward-delivered', {
      count: this.userData.rewardCount,
      timestamp: Date.now()
    })
  }
}
```

### 3. Registering the Controller

There are two ways to register a custom controller:

#### Method 1: Place in User Directory

Place the controller file in the `controllers` folder of the user data directory:

- Windows: `%APPDATA%\three-maze\controllers\`
- macOS: `~/Library/Application Support/three-maze/controllers/`
- Linux: `~/.config/three-maze/controllers/`

These controllers will be automatically loaded when the application starts.

#### Method 2: Modify the Controller Loader

You can also modify the `electron/scripts/controller-loader.js` file, registering your controller in the `registerBuiltinControllers` method:

```javascript
registerBuiltinControllers() {
  this.registerControllerClass('serial-hallway', SerialHallwayController)
  this.registerControllerClass('my-experiment', MyExperimentController) // Add this line
}
```

Then import your controller at the appropriate location:

```javascript
import { MyExperimentController } from './controllers/my-experiment-controller.js'
```

### 4. Using Controllers in Scenes

To use a controller in a scene, you need to specify the controller type in the scene configuration:

```json
{
  "id": "my_experiment_scene",
  "name": "My Experiment Scene",
  "description": "A custom experiment scene",
  "controllerType": "my-experiment",
  "camera": {
    "position": {"x": 0, "y": 5, "z": 10}
  },
  // Other scene configuration...
}
```

Alternatively, the controller loader will automatically select an appropriate controller based on the scene ID.

### 5. Communicating with Controllers in Scene Components

In Vue components, you can communicate with controllers like this:

```javascript
<script setup>
import { onMounted, onUnmounted, ref } from 'vue'

const position = ref({ x: 0, y: 0, z: 0 })
const rewardCount = ref(0)

onMounted(() => {
  // Listen for position updates
  window.electron.controller.onPositionUpdate((data) => {
    position.value = data
  })
  
  // Listen for reward events
  window.electron.controller.onRewardDelivered((data) => {
    rewardCount.value = data.count
  })
  
  // Listen for controller ready events
  window.electron.controller.onControllerReady(() => {
    console.log('Controller is ready')
  })
})

// Send commands to the controller
function resetPosition() {
  window.electron.controller.resetPosition()
}

function deliverReward() {
  window.electron.controller.deliverReward()
}
</script>
```

## Scene Controller API Reference

### Lifecycle Methods

* `onInitialize()` - Initialize the controller
* `onUpdate()` - Periodic updates
* `onDispose()` - Destroy and clean up resources

### Communication Methods

* `sendToScene(channel, ...args)` - Send a message to the scene
* `setupIpc(ipcMain, ipcManager)` - Set up custom IPC handlers

### Common Settings

* `this.userData` - Store custom user state
* `this.config` - Store configuration parameters
* `this.window` - Reference to the scene window

## Frontend API Reference

APIs for accessing controllers from frontend Vue components:

### Event Listeners

* `window.electron.controller.onPositionUpdate(callback)` - Listen for position updates
* `window.electron.controller.onPositionReset(callback)` - Listen for position resets
* `window.electron.controller.onRewardDelivered(callback)` - Listen for reward events
* `window.electron.controller.onSerialData(callback)` - Listen for serial data
* `window.electron.controller.onPythonData(callback)` - Listen for Python data
* `window.electron.controller.onControllerReady(callback)` - Listen for controller ready events

### Command Methods

* `window.electron.controller.resetPosition()` - Reset position
* `window.electron.controller.deliverReward()` - Trigger reward
* `window.electron.controller.getDataLog()` - Get data log

### Generic Methods

* `window.electron.controller.on(channel, callback)` - Listen for any event
* `window.electron.controller.invoke(channel, ...args)` - Call any method
* `window.electron.controller.send(channel, ...args)` - Send any message

## Advanced Usage

### Hardware Integration

For scenes that need to communicate with hardware devices, you can implement serial communication logic in the controller. For example:

```javascript
async initializeSerial() {
  const { SerialPort } = await import('serialport')
  const ports = await SerialPort.list()
  
  if (ports.length === 0) {
    console.warn('No serial ports available')
    return false
  }
  
  this.serialPort = new SerialPort({
    path: ports[0].path,
    baudRate: 115200
  })
  
  this.serialPort.on('data', (data) => {
    // Process received data
    this.sendToScene('serial-data', data)
  })
  
  return true
}
```

### Python Integration

For scenes requiring Python processing, you can start a Python process:

```javascript
async initializePython() {
  const { spawn } = await import('child_process')
  
  this.pythonProcess = spawn('python3', ['-m', 'your_python_module'], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  
  this.pythonProcess.stdout.on('data', (data) => {
    // Process Python output
    this.sendToScene('python-data', data.toString())
  })
  
  return true
}
```

## Troubleshooting

### Controller Not Loading

* Ensure the controller class name ends with "Controller"
* Ensure the controller file exports the controller class
* Check that the controller file is in the correct location

### Communication Issues

* Check that frontend event names match those sent by the controller
* Add logs in controller code to track message flow

### Performance Issues

* Avoid time-consuming operations in the `onUpdate()` method
* Consider reducing the update frequency (increase the `updateRate` value)
* Use batching or throttling techniques for sending frequently updated data