<script setup>
import { ref, onMounted } from 'vue'

const displays = ref([])
const selectedDisplay = ref(null)

onMounted(async () => {
  if (window.electron) {
    const availableDisplays = await window.electron.getDisplays()
    displays.value = availableDisplays
    
    const preferredDisplayId = await window.electron.getPreferredDisplay()
    selectedDisplay.value = preferredDisplayId || availableDisplays.find(d => d.isPrimary)?.id
    
    handleDisplayChange(selectedDisplay.value)
    
    window.electron.onDisplayChanged((displayId) => {
      selectedDisplay.value = Number(displayId)
    })
  }
})

const handleDisplayChange = (displayId) => {
  if (!displayId) return
  
  selectedDisplay.value = Number(displayId)
  if (window.electron) {
    window.electron.setPreferredDisplay(selectedDisplay.value)
  }
}
</script>

<template>
  <nav class="navigation">
    <div class="nav-content">
      <div class="nav-links">
        <router-link to="/" class="nav-link">Observe Gallery</router-link>
        <router-link to="/physics-mazes" class="nav-link">Interactive Mazes</router-link>
        <router-link to="/serial-control" class="nav-link">Serial Control</router-link>
      </div>
      
      <!-- Display selector -->
      <div class="display-selector">
        <label for="display-select">Display:</label>
        <select 
          id="display-select" 
          v-model="selectedDisplay"
          @change="handleDisplayChange($event.target.value)"
          class="display-select"
        >
          <option 
            v-for="display in displays" 
            :key="display.id" 
            :value="display.id"
          >
            {{ display.isPrimary ? 'Primary Display' : `Display ${display.id}` }}
          </option>
        </select>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.navigation {
  background-color: #1a1a1a;
  padding: 1rem 0;
  padding-top: 40px;
  position: fixed;
  top: 0;
  width: 100%;
  z-index: 1000;
}

.nav-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 2rem;
}

.nav-links {
  display: flex;
  gap: 2rem;
}

.nav-link {
  color: white;
  text-decoration: none;
  font-size: 1.1rem;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  transition: background-color 0.3s ease;
}

.nav-link:hover {
  background-color: #333;
}

.router-link-active {
  background-color: #333;
}

.display-selector {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.display-selector label {
  color: white;
  font-size: 1rem;
}

.display-select {
  background-color: #333;
  color: white;
  border: none;
  padding: 0.5rem;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
}

.display-select:hover {
  background-color: #444;
}

.display-select:focus {
  outline: none;
  box-shadow: 0 0 0 2px #666;
}
</style> 