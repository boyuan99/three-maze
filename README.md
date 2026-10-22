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

- [Node.js](https://nodejs.org/en) 22.12 or newer (an LTS version; Electron 44 needs at least 22.12)
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

`npm install` does not download the Electron binary (Electron 42 and later download it when it is
first needed): the first `npm run electron:dev` or `npm run test:e2e` downloads it into
`node_modules/electron/dist`, which needs network access. To download it right away, for example
before the computer goes offline, run `npx --no install-electron`.

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

Check that the Electron app packages (output in `release/win-unpacked/`):

```bash
npm run electron:build -- --dir
```

The package holds the renderer and Electron only, without Python, the backend or the
experiments, so it cannot run a session; a runnable installer is not set up yet.

## Development and tests

The tests and CI use Node.js 22 and Python 3.12. `npm install` also creates the Python virtual
environment `.venv` and installs `requirements-dev.txt` into it: the backend's exact pins
(`requirements.txt`) plus pytest.

```bash
npm test                         # JavaScript unit tests (Vitest, test/frontend)
npm run typecheck                # TypeScript type check (tsc, tsconfig.json; src/render without the DOM)
.venv/Scripts/python -m pytest   # Python backend tests (test/backend); .venv/bin/python on macOS and Linux
npm run test:e2e                 # end-to-end bench, Windows only, about 1 minute
npm run test:render              # the render host draws the six shipped mazes in Electron, about 15 s
npm run test:stall               # ADR-0003's stall suite (timing, by hand), about 6 minutes
```

None of them needs a Teensy, an NI-DAQ device or a `D:` drive. The end-to-end bench runs the real
renderer and backend in a hidden Electron window with a simulated Teensy and NI-DAQ; see
[test/e2e/README.md](test/e2e/README.md). The render host (`src/render`) and its development page
are described in [src/render/README.md](src/render/README.md) and
[test/render/README.md](test/render/README.md), the stall suite in
[test/perf/stall/README.md](test/perf/stall/README.md). Some backend tests use the same simulated
rig (`test/e2e/sim`) without Electron, to check that registration fails cleanly when COM3 or the
`D:` drive is missing.

The backend tests that start the backend as a process need its port 8765, which three-maze itself
uses. Close three-maze first (and let an end-to-end bench run finish): while the port is taken,
pytest skips those tests with "close three-maze first" in its summary instead of running them.

GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the unit tests, the type
check, `npm run build` and the backend tests on Windows for every push and pull request. The
end-to-end bench runs there only when started by hand (Actions > CI > Run workflow).

### Rig tools

Commands for a rig visit, for PowerShell in the repository folder with three-maze closed. Only the
capture needs the Teensy; nothing needs the NI-DAQ device. Every output goes to `out\`, which git
ignores.

```powershell
# 1. Update: git pull, npm ci, the Electron binary, the Python packages; prints and saves the versions
powershell -ExecutionPolicy Bypass -File scripts\rig-update.ps1
powershell -ExecutionPolicy Bypass -File scripts\rig-update.ps1 -Ref phase1-gate-1   # a tag or branch

# 2. Displays, GPUs, versions and Windows session as one JSON file
npm run rig:info

# 3. Audit the v0.3 data files (read-only); keep the quotes around the pattern
.venv\Scripts\python tools\retro_gain_check.py "D:\VirmenData\*.txt" --csv out\audit.csv

# 4. Optional: record the Teensy's stream as it arrives, for 30 minutes (Ctrl+C stops early)
.venv\Scripts\python tools\capture_raw.py --port COM3 --minutes 30
```

1. `scripts\rig-update.ps1` refuses to run if tracked files have local changes, and needs network
   access for git, npm, the Electron download (since Electron 42 `npm ci` no longer downloads it)
   and pip. It prints Node, npm, Electron (package and binary), three.js, Rapier, Python and every
   package pinned in `requirements.txt` against its pin, with the time each step took, and saves
   the printout in `out\rig-update\`. Exit code 1 if a step failed or a version does not match its
   pin. On the development PC, on clean clones with the npm, pip and Electron download caches
   already filled, it took 36-39 s in two runs (31-35 s of it `npm ci`); a first run on the rig
   downloads everything and takes longer (not measured).
2. `npm run rig:info` writes `out\rig-info\rig-info-<computer>-<date>-<time>.json` (or the file
   given with `-- --out FILE`) and prints a summary with warnings: displays at different refresh
   rates, a remote-desktop session, software rendering, several GPUs. It names the primary
   display by Electron's `screen.getPrimaryDisplay()`, opens no visible window and changes nothing.
3. `tools\retro_gain_check.py` takes files or glob patterns (expanded by the tool, since cmd and
   PowerShell pass them on unexpanded) and writes one CSV row per file: effective gain, device
   period, lost samples, heading checks. A file it cannot analyse gets its error in the CSV and the
   audit goes on (exit code 1). It refuses to write the CSV into a folder that holds data files.
4. `tools\capture_raw.py` sends the device nothing but v0.3's init line (`10000,50,10,1`, 2 s
   after opening the port, as the hallway experiments do; `--no-init` sends nothing) and writes
   every line it receives, exactly as received, with the host's `perf_counter_ns` time stamp, to
   `out\capture\`. Change `--port` if the control file names another port.

### Dependency versions

Electron, three.js, Rapier and the backend's runtime packages (`requirements.txt`) can change what
the animal sees or how it moves, so they are pinned to exact versions, and so is Ajv, which decides
which link-protocol messages are accepted ([protocol/v1](protocol/v1/SPEC.md)). Development tools
and the user-interface libraries use version ranges, and `package-lock.json` records the versions
installed. Dependabot ([.github/dependabot.yml](.github/dependabot.yml)) proposes updates monthly
as pull requests that CI tests; the pinned packages are frozen while paper data are collected. See
[ADR-0004](docs/adr/0004-dependency-versions.md).

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
- `/backend`, `/experiments` - the v0.3 Python backend and its experiments
- `/threemaze` - the v1 rig runtime (Python), replacing the v0.3 backend during phase 1
- `/rigs` - rig files and their schema ([docs/rig-file-v1.md](docs/rig-file-v1.md))
- `/public` - Static assets
- `/protocol` - the link protocol between the rig runtime, the motion worker and monitors:
  schemas, examples and specification ([protocol/v1/SPEC.md](protocol/v1/SPEC.md))

## Technical Stack

- Three.js - 3D graphics
- Vue 3 - UI framework
- Rapier3D - Physics engine
- Electron - Desktop application framework
- Vite - Build tool and development server
