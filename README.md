# Three-Maze

A VR environment designed for animal behavior research, built with Three.js, Vue.js, and Electron.

## Features

- Multiple demo scenes with physics interactions
- Customizable 3D hallway environments
- Scene preview and management system
- Support for custom scene configurations via JSON
- Physics engine integration using Rapier3D
- VR-ready rendering capabilities

## Prerequisites

- [Node.js](https://nodejs.org/en) (Latest LTS version recommended)
- A modern web browser with WebGL support
- Graphics card with up-to-date drivers

## Installation

1. Clone the repository:

```bash
git clone https://github.com/boyuan99/three-maze.git
cd three-maze
```

2. Install dependencies:

```bash
npm install
```

## Development

Start the development server:

```bash
npm run dev
```

For Electron development:

```bash
npm run electron:dev
```

## Building

Build for web:

```bash
npm run build
```

Build Electron application:

```bash
npm run electron:build
```

## Scene Configuration

The application supports custom scene configurations through JSON files. Example structure:

```json
{
  "name": "Custom Scene",
  "description": "Scene description",
  "camera": {
    "position": {"x": 0, "y": 5, "z": 30},
    "fov": 75
  },
  "objects": [
    {
      "name": "floor",
      "geometry": {
        "type": "box",
        "width": 10,
        "height": 0.1,
        "depth": 10
      },
      "material": {
        "color": 8421504,
        "metalness": 0.1,
        "roughness": 0.7
      }
    }
  ]
}
```

### Custom Scenes Storage Locations

Custom scenes and display preferences are automatically saved in your system's application data directory:

#### Windows
```
User Data: C:\Users\{username}\AppData\Roaming\maze-app\
Custom Scenes: C:\Users\{username}\AppData\Roaming\maze-app\customScenes.json
Display Preferences: C:\Users\{username}\AppData\Roaming\maze-app\displayPreference.json
```

#### macOS
```
User Data: ~/Library/Application Support/maze-app/
Custom Scenes: ~/Library/Application Support/maze-app/customScenes.json
Display Preferences: ~/Library/Application Support/maze-app/displayPreference.json
```

#### Linux
```
User Data: ~/.config/maze-app/
Custom Scenes: ~/.config/maze-app/customScenes.json
Display Preferences: ~/.config/maze-app/displayPreference.json
```

## Controls

- **Orbit Controls:**
  - Left-click drag: Rotate camera
  - Right-click drag: Pan camera
  - Scroll: Zoom in/out

## Troubleshooting

### Port Already in Use

The application requires ports 5000 and 5173. To free these ports:

1. Find the process using the port:

```bash
sudo lsof -i:5000
sudo lsof -i:5173
```

2. Kill the process:

```bash
kill <PID>
```

### Chrome Socket Issues

1. Navigate to `chrome://net-internals/#sockets`
2. Click "Flush socket pools"
3. Restart the application

## Project Structure

- `/src` - Source code
  - `/worlds` - 3D world implementations
  - `/scenes` - Vue scene components
  - `/components` - Reusable Vue components
- `/mazes` - Maze configuration files
- `/electron` - Electron-specific code
- `/public` - Static assets

## Technical Stack

- Three.js - 3D graphics
- Vue 3 - UI framework
- Rapier3D - Physics engine
- Electron - Desktop application framework
- Vite - Build tool and development server
