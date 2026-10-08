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
- [Python](https://www.python.org/downloads/) 3.11 or newer (3.12 recommended) for the backend, as
  `python` on the PATH (`python3` on macOS and Linux)
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

`npm install` also creates the Python virtual environment `.venv` for the backend with the first
`python` on the PATH, which must be Python 3.11 or newer (3.12 recommended); check with
`python --version`. If that check, creating `.venv` or installing the Python packages fails,
`npm install` fails with a "Python setup FAILED" box that says what to do; after fixing it, run
`node setup/setup-python.js` to finish the Python part.

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

## Development and tests

The tests and CI use Node.js 22 and Python 3.12. `npm install` also creates the Python virtual
environment `.venv` and installs `requirements-dev.txt` into it: the backend's exact pins
(`requirements.txt`) plus pytest.

```bash
npm test                         # JavaScript unit tests (Vitest, test/frontend)
npm run typecheck                # TypeScript type check (tsc, tsconfig.json)
.venv/Scripts/python -m pytest   # Python backend tests (test/backend); .venv/bin/python on macOS and Linux
npm run test:e2e                 # end-to-end bench, Windows only, about 1 minute
```

None of them needs a Teensy, an NI-DAQ device or a `D:` drive. The end-to-end bench runs the real
renderer and backend in a hidden Electron window with a simulated Teensy and NI-DAQ; see
[test/e2e/README.md](test/e2e/README.md). Some backend tests use the same simulated rig
(`test/e2e/sim`) without Electron, to check that registration fails cleanly when COM3 or the
`D:` drive is missing.

The backend tests that start the backend as a process need its port 8765, which three-maze itself
uses. Close three-maze first (and let an end-to-end bench run finish): while the port is taken,
pytest skips those tests with "close three-maze first" in its summary instead of running them.

GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the unit tests, the type
check, `npm run build` and the backend tests on Windows for every push and pull request. The
end-to-end bench runs there only when started by hand (Actions > CI > Run workflow).

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
