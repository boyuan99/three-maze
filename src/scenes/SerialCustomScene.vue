<script setup>
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import { scenes } from '@/scenes'
import { SerialCustomWorld } from '@/worlds/SerialCustomWorld'

const route = useRoute()
const canvas = ref(null)
const world = shallowRef(null)
const showInfo = ref(true)
const sceneName = ref('Serial Custom Scene')
const sceneDescription = ref('A custom scene for serial control')
const error = ref(null)
const controlFile = ref(null)
const experimentCode = ref(null)
const isActive = ref(true)
const experimentState = ref({})

// Serial control state
const serialData = ref(null)
const position = ref({ x: 0, y: 0, theta: 0 })

onMounted(async () => {
  console.log('SerialCustomScene: Mounting component')
  console.log('SerialCustomScene: Route params:', route.params)
  console.log('SerialCustomScene: Available scenes:', scenes)

  if (!canvas.value) {
    console.error('SerialCustomScene: Canvas not found')
    return
  }

  let sceneConfig = null
  let controlFileData = null
  const sceneId = route.params.id
  console.log('SerialCustomScene: Looking for scene with ID:', sceneId)

  if (window.electron) {
    console.log('SerialCustomScene: Running in Electron mode')
    try {
      // Add a small delay to ensure IPC is ready
      await new Promise(resolve => setTimeout(resolve, 500))

      const data = await window.electron.getSceneConfig()
      console.log('SerialCustomScene: Received data from electron:', data)

      if (data && data.config) {
        sceneConfig = data.config
        controlFileData = data.controlFile
        console.log('SerialCustomScene: Got config from electron:', sceneConfig)
        console.log('SerialCustomScene: Got control file:', controlFileData)
      } else {
        console.error('SerialCustomScene: No config in electron data')
      }
    } catch (err) {
      console.error('SerialCustomScene: Error getting config from electron:', err)
      error.value = 'Failed to get scene configuration from Electron'
    }
  } else {
    console.log('SerialCustomScene: Running in browser mode')
    const scene = scenes.find(s => s.id === sceneId)
    console.log('SerialCustomScene: Found scene:', scene)
    sceneConfig = scene?.config
    
    // Try to get control file from session storage
    try {
      const storedControlFile = sessionStorage.getItem(`controlFile_${sceneId}`)
      if (storedControlFile) {
        controlFileData = JSON.parse(storedControlFile)
      }
    } catch (err) {
      console.warn('Failed to get control file from session storage:', err)
    }
  }

  if (!sceneConfig) {
    const errorMsg = 'Scene configuration not found for: ' + sceneId
    console.error('SerialCustomScene:', errorMsg)
    error.value = errorMsg
    return
  }

  // Update scene info
  console.log('SerialCustomScene: Initializing with config:', sceneConfig)
  sceneName.value = sceneConfig.name
  sceneDescription.value = sceneConfig.description || 'A custom scene for serial control'

  // Load control file if available
  if (controlFileData && controlFileData.content) {
    try {
      controlFile.value = controlFileData
      await loadExperimentCode(controlFileData.content)
    } catch (err) {
      console.error('Error loading control file:', err)
      error.value = 'Error loading control file: ' + err.message
    }
  }

  // Initialize world with configuration
  try {
    world.value = new SerialCustomWorld(canvas.value, sceneConfig)
    await world.value.init()
    
    // Initialize experiment if code is loaded
    if (experimentCode.value && experimentCode.value.initialization) {
      try {
        experimentState.value = await experimentCode.value.initialization(createVRInterface())
        console.log('Experiment initialized')
      } catch (err) {
        console.error('Error initializing experiment:', err)
        error.value = 'Error initializing experiment: ' + err.message
      }
    }
    
    console.log('SerialCustomScene: World initialized successfully')
    
    // Set up serial connection if available
    if (window.electron) {
      try {
        const result = await window.electron.initializeJsSerial()
        if (result.error) {
          console.error('Serial initialization failed:', result.error)
          error.value = result.error
        } else {
          console.log('Serial connection initialized successfully')
          // Set up serial data handler
          window.electron.onSerialData((data) => {
            serialData.value = data
            updateFromSerial(data)
          })
        }
      } catch (err) {
        console.error('Error setting up serial connection:', err)
        error.value = 'Error setting up serial connection: ' + err.message
      }
    }
    
    // Start animation loop
    animate()
    
  } catch (err) {
    console.error('SerialCustomScene: Error initializing world:', err)
    error.value = 'Error initializing world: ' + err.message
  }
})

async function loadExperimentCode(codeString) {
  try {
    // Create a function from the code string
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
    const codeFunction = new AsyncFunction('window', 'console', codeString + '\n; return typeof serialHallwayExperiment !== "undefined" ? serialHallwayExperiment() : null;')
    
    // Execute the function to get the experiment object
    const experimentObj = await codeFunction(window, console)
    
    if (experimentObj && experimentObj.initialization && experimentObj.runtime && experimentObj.termination) {
      experimentCode.value = experimentObj
      console.log('Experiment code loaded successfully')
    } else {
      throw new Error('Invalid experiment code structure')
    }
  } catch (err) {
    console.error('Error loading experiment code:', err)
    throw err
  }
}

function createVRInterface() {
  // Create a VR-like interface object that the experiment code expects
  const vrInterface = {
    position: [0, 0, 0.5, 0], // [x, y, z, theta]
    velocity: [0, 0, 0, 0],
    dt: 1/60, // 60fps
    isActive: true,
    fallStartTime: null,
    serialData: null,
    // Add other properties as needed
    HALLWAY_LENGTH: 200,
    HALLWAY_WIDTH: 40,
    WALL_HEIGHT: 10,
    PLAYER_RADIUS: 0.5,
    MAX_LINEAR_VELOCITY: 100,
    DT: 1/20,
    FALL_RESET_TIME: 5000,
    endy: 70,
    water: 0,
    numrewards: 0,
    isTrialStart: true,
    isTrialEnd: false
  }
  
  // If we have a world with physics, sync with it
  if (world.value && world.value.playerBody) {
    const worldPos = world.value.getPlayerPosition()
    vrInterface.position = [worldPos.x, worldPos.z, worldPos.y, world.value.playerRotation]
    
    const worldVel = world.value.getPlayerVelocity()
    vrInterface.velocity = [worldVel.x, worldVel.z, worldVel.y, 0]
  }
  
  return vrInterface
}

function updateFromSerial(data) {
  if (!experimentCode.value || !experimentState.value) {
    console.log('No experiment code loaded, using default serial handling')
    return
  }
  
  try {
    // Update experiment state with serial data
    experimentState.value.serialData = data
    
    // Run the experiment runtime code
    if (experimentCode.value.runtime) {
      experimentState.value = experimentCode.value.runtime(experimentState.value)
    }
    
    // Update visual position based on experiment state
    if (experimentState.value.position && world.value) {
      position.value.x = experimentState.value.position[0]
      position.value.y = experimentState.value.position[1] 
      position.value.theta = experimentState.value.position[3]
      
      // Apply position and rotation to physics world if available
      if (world.value.playerBody) {
        // Set player position
        world.value.setPlayerPosition({
          x: experimentState.value.position[0],
          y: experimentState.value.position[2], // Y is up in 3D
          z: experimentState.value.position[1]  // Z is forward/back
        })
        
        // Set player rotation
        world.value.setPlayerRotation(experimentState.value.position[3])
      }
      
      // Apply velocity if available
      if (experimentState.value.velocity && world.value.playerBody) {
        world.value.setPlayerVelocity({
          x: experimentState.value.velocity[0],
          y: experimentState.value.velocity[2], // Y is up in 3D
          z: experimentState.value.velocity[1]  // Z is forward/back
        })
      }
    }
  } catch (err) {
    console.error('Error in experiment runtime:', err)
  }
}

function animate() {
  if (!isActive.value) return
  
  requestAnimationFrame(animate)
  
  if (world.value) {
    world.value.animate()
  }
}

onBeforeUnmount(async () => {
  console.log('SerialCustomScene: Unmounting component')
  
  isActive.value = false
  
  // Run experiment termination code
  if (experimentCode.value && experimentCode.value.termination && experimentState.value) {
    try {
      await experimentCode.value.termination(experimentState.value)
      console.log('Experiment terminated')
    } catch (err) {
      console.error('Error in experiment termination:', err)
    }
  }
  
  if (world.value) {
    world.value.dispose()
    world.value = null
  }
  
  // Close serial connection
  if (window.electron) {
    try {
      await window.electron.closeJsSerial()
      console.log('Serial connection closed successfully')
    } catch (err) {
      console.error('Error closing serial connection:', err)
    }
  }
})
</script>

<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>

    <!-- Error Display -->
    <div v-if="error" class="error-overlay">
      <div class="error-content">
        <h3>Error</h3>
        <p>{{ error }}</p>
      </div>
    </div>

    <!-- Info Overlay -->
    <div v-else-if="showInfo" class="overlay-info">
      <div class="info-panel">
        <h3>{{ sceneName }}</h3>
        <p>{{ sceneDescription }}</p>
        
        <div v-if="controlFile" class="control-info">
          <p><strong>Control File:</strong> {{ controlFile.name }}</p>
          <p><strong>Type:</strong> {{ controlFile.type }}</p>
        </div>
        <div v-else class="control-info">
          <p style="color: #ff6b6b;"><strong>No control file loaded</strong></p>
        </div>
        
        <div class="position-info">
          <p><strong>Position:</strong></p>
          <ul>
            <li>X: {{ position.x.toFixed(2) }}</li>
            <li>Y: {{ position.y.toFixed(2) }}</li>
            <li>θ: {{ position.theta.toFixed(2) }}</li>
          </ul>
        </div>
        
        <p>This scene combines JSON configuration with control file logic</p>
      </div>
      <button class="toggle-info" @click="showInfo = false">Hide Info</button>
    </div>
    <button
      v-else
      class="toggle-info-mini"
      @click="showInfo = true"
    >
      Show Info
    </button>
  </div>
</template>

<style scoped>
.scene-container {
  width: 100vw;
  height: 100vh;
  position: relative;
  overflow: hidden;
}

canvas {
  width: 100%;
  height: 100%;
}

.overlay-info {
  position: absolute;
  top: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.info-panel {
  background: rgba(0, 0, 0, 0.7);
  padding: 20px;
  border-radius: 8px;
  color: white;
  min-width: 250px;
}

.info-panel h3 {
  margin: 0 0 15px 0;
  text-align: center;
}

.control-info {
  margin: 15px 0;
  padding: 10px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.position-info {
  margin: 15px 0;
}

.position-info ul {
  margin: 5px 0 0 0;
  padding-left: 20px;
}

.position-info li {
  margin: 5px 0;
}

.error-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.error-content {
  background: #ff4444;
  padding: 20px;
  border-radius: 8px;
  color: white;
  text-align: center;
  max-width: 500px;
}

.toggle-info,
.toggle-info-mini {
  background: rgba(0, 0, 0, 0.7);
  color: white;
  border: none;
  padding: 10px 15px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.3s;
}

.toggle-info:hover,
.toggle-info-mini:hover {
  background: rgba(0, 0, 0, 0.9);
}

.toggle-info-mini {
  position: absolute;
  top: 20px;
  right: 20px;
}
</style>