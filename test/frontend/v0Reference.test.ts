// The v0 reference loader (src/compat/v0) against v0.3's own loader.
//
// For each shipped maze, v0.3's loader functions are taken from PythonCustomScene.vue and run in
// Node (v0Reference/extractV03.ts); what they build is recorded in v0Reference/golden/<maze>.json:
// the scene graph with transforms, materials, textures, lights and camera, the renderer settings,
// and the Rapier bodies and colliders. The port must produce the same record. To regenerate the
// golden files after a deliberate change to v0.3, run `npx vitest run test/frontend/v0Reference.test.ts -u`;
// they are only ever written from v0.3's output, never from the port's.
//
// Not compared (see v0Reference/harness.ts): JPEG pixels and sizes (Node has no <img>), what the GPU
// draws (no WebGL), and anything after setup (frames, resizes, the physics simulation).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildV0Scene, describeScene, placeV0Camera, v0Physics } from '../../src/compat/v0/index.ts'
import type { V0SceneConfig } from '../../src/compat/v0/index.ts'
import { FixedFollowCam } from '../../src/utils/FixedFollowCam.js'
import { runV03CameraUpdate } from './v0Reference/extractV03.ts'
import {
  fetchFromPublic, formatRecord, nodeLoaders, readMaze, recordPort, recordV03, REPO_ROOT, shippedMazes, viaJson, WINDOW
} from './v0Reference/harness.ts'
import type { LoaderRecord, Maze } from './v0Reference/harness.ts'

const goldenFile = (maze: Maze) => `./v0Reference/golden/${maze.name}.json`

// v0.3's record of each maze, made once and shared by the tests of that maze
const v03Records = new Map<string, Promise<LoaderRecord>>()
const v03Record = (maze: Maze) => {
  if (!v03Records.has(maze.name)) v03Records.set(maze.name, recordV03(readMaze(maze), maze.file))
  return v03Records.get(maze.name)!
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchFromPublic)
  await RAPIER.init()
})

afterAll(() => {
  vi.unstubAllGlobals()
})

const mazes = shippedMazes()

it('covers the six shipped mazes', () => {
  expect(mazes.map(maze => maze.name)).toEqual(['Example01', 'Hallway01', 'Hallway02', 'Hallway04', 'HallwaySerialMigrated', 'Hallway_fog'])
})

describe.each(mazes)('$name', maze => {
  it("v0.3's own loader builds the golden snapshot", async () => {
    await expect(formatRecord(await v03Record(maze))).toMatchFileSnapshot(goldenFile(maze))
  })

  // With the test above, the port's record is also the golden snapshot
  it('the port builds the same scene, renderer settings and colliders as v0.3', async () => {
    const record = await recordPort(readMaze(maze), maze.file)
    expect(viaJson(record)).toEqual(viaJson(await v03Record(maze)))
  })

  it("gives each solid its mesh's position and rotation", async () => {
    const config = readMaze(maze)
    const { meshes } = await buildV0Scene(config, { aspect: 1, loaders: nodeLoaders })
    const { solids } = v0Physics(config)
    expect(solids.length).toBeGreaterThan(0)
    for (const solid of solids) {
      const { mesh } = meshes.find(entry => entry.objectIndex === solid.objectIndex)!
      expect(solid.position).toEqual([mesh.position.x, mesh.position.y, mesh.position.z])
      expect(solid.meshRotation).toEqual([mesh.rotation.x, mesh.rotation.y, mesh.rotation.z])
    }
  })
})

it("reports Example01's sphere as a dynamic body", () => {
  const physics = v0Physics(readMaze(mazes.find(maze => maze.name === 'Example01')!))
  expect(physics.solids.map(solid => [solid.name, solid.body, solid.shape.kind])).toEqual([
    ['floor', 'fixed', 'cuboid'],
    ['sphere', 'dynamic', 'ball']
  ])
  expect(physics.diagnostics).toEqual(['object 1 (sphere): dynamic body; in v0.3 it falls under gravity -500'])
})

describe('quirks (src/compat/v0/README.md)', () => {
  const box = { type: 'box', width: 2, height: 1, depth: 4 }
  const quirky: V0SceneConfig = {
    _basePath: 'mazes/Hallway04/',
    camera: { fov: 0, position: { x: 5, y: 5, z: 5 }, near: 1, far: 10 },
    lights: [
      { type: 'point', color: 0xff0000, intensity: 2, position: { x: 1, y: 2, z: 3 }, castShadow: true, distance: 60, decay: 1 },
      { type: 'hemisphere', color: 0x00ff00 },
      { type: 'directional', position: { x: 0, y: 10, z: 0 } }
    ],
    objects: [
      { name: 'black', geometry: box, material: { color: 0, roughness: 0, metalness: 0.5 }, physics: { enabled: true, friction: 0 } },
      { name: 'rotated', geometry: box, rotation: { x: 0, y: Math.PI / 4, z: 0 }, position: { x: 3, y: 0.5, z: -2 }, physics: { enabled: true, type: 'static' } },
      { name: 'zero size', geometry: { type: 'box', width: 0, height: 0, depth: 0 }, physics: { enabled: true, restitution: 0.25 } },
      { name: 'cone', geometry: { type: 'cylinder', radiusTop: 0.2, radiusBottom: 1, height: 2 }, physics: { enabled: true, type: 'kinematic' } },
      { name: 'plane', geometry: { type: 'plane', width: 5 }, physics: { enabled: true, type: 'dynamic' } },
      { name: 'missing texture', geometry: box, material: { map: 'assets/missing.jpg', repeat: { x: 2, y: 2 } } },
      { name: 'textured', geometry: box, material: { map: 'assets/Chess_Pattern.jpg', repeat: { x: 2, y: 3 } }, castShadow: true }
    ]
  } as V0SceneConfig   // the extra camera and light keys are what v0.3 ignores

  const live = async (config: V0SceneConfig) => {
    const v03 = await recordV03(config, 'fixture')
    const port = await recordPort(config, 'fixture')
    expect(viaJson(port)).toEqual(viaJson(v03))
    return viaJson(v03)
  }

  it('the port reproduces them as v0.3 builds them', async () => {
    const record = await live(quirky)
    const meshes = record.scene.children.filter(node => node.type === 'Mesh')
    const material = (index: number) => meshes[index].material as Record<string, any>

    // `||` defaults: colour 0 is white, roughness 0 is 1, size 0 is 1, fov 0 is 75, friction 0 is 0.5;
    // the JSON's camera position, near and far are ignored
    expect(material(0).color.hex).toBe('#ffffff')
    expect(material(0).roughness).toBe(1)
    expect(meshes[2].geometry!.parameters).toMatchObject({ width: 1, height: 1, depth: 1 })
    const camera = record.scene.children.at(-1)!.children[0].children[0]
    expect(camera.camera).toMatchObject({ fov: 75, near: 0.1, far: 1000, aspect: WINDOW.innerWidth / WINDOW.innerHeight })
    expect(camera.position).toEqual([0, 1.6, 0])
    expect(record.physics.colliders[0].friction).toBe(0.5)

    // The collider drops the rotation the mesh has
    expect(meshes[1].rotation.slice(0, 3)).toEqual([0, Math.PI / 4, 0])
    expect(record.physics.colliders[1].rotation).toEqual([0, 0, 0, 1])

    // Cylinder collider: radiusTop only; any type but 'dynamic' is fixed
    expect(record.physics.colliders[3].shape).toEqual({ type: 'Cylinder', halfHeight: 1, radius: Math.fround(0.2) })
    expect(record.physics.bodies.slice(0, 5).map(body => body.type)).toEqual(['Fixed', 'Fixed', 'Fixed', 'Fixed', 'Dynamic'])

    // An unsupported geometry has no mesh but, with physics, a body without a collider
    expect(meshes).toHaveLength(6)
    expect(record.physics.bodies).toHaveLength(6)        // five scene bodies and the player
    expect(record.physics.colliders.map(collider => collider.body)).toEqual([0, 1, 2, 3, 5])

    // Point lights: range 50 and decay 2 whatever the JSON says; unsupported light types are skipped
    const lights = record.scene.children.filter(node => node.light)
    expect(lights.map(node => node.type)).toEqual(['PointLight', 'DirectionalLight'])
    expect(lights[0].light).toMatchObject({ distance: 50, decay: 2 })
    expect(lights[0].castShadow).toBe(true)
    expect(lights[1].light!.target).toEqual({ position: [0, 0, 0], inSceneGraph: false })

    // A texture that fails to load leaves the flat colour; textures are not marked sRGB
    expect(material(4).maps).toEqual({})
    expect(material(5).maps.map).toMatchObject({ label: '/mazes/Hallway04/assets/Chess_Pattern.jpg', repeat: [2, 3], wrapS: THREE.RepeatWrapping, colorSpace: '' })

    // Renderer: ACES tone mapping requested in the constructor, shadows always on, pixel ratio never set
    expect(record.renderer).toEqual({
      canvas: 'the scene canvas',
      parameters: { antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1 },
      calls: [['setSize', WINDOW.innerWidth, WINDOW.innerHeight, true]],
      writes: [['shadowMap.enabled', true], ['physicallyCorrectLights', true]]
    })
  })

  it('the eye is 3.2 above the player body: 3.7 at the start', async () => {
    const record = await live({ ...quirky, lights: [] })
    expect(record.scene.children.filter(node => node.light)).toEqual([])   // an empty list stays empty
    expect(record.scene.camera!.worldPosition).toEqual([0, 0.5 + 1.6 + 1.6, 0])
    expect(record.scene.camera!.worldDirection).toEqual([0, 0, -1])
  })

  it('without a lights key, v0.3 adds an ambient and a directional light', async () => {
    const { lights: _ignored, ...config } = quirky
    const record = await live(config)
    expect(record.scene.children.filter(node => node.light).map(node => [node.type, node.light!.intensity, node.castShadow]))
      .toEqual([['AmbientLight', 0.5, false], ['DirectionalLight', 1, true]])
  })

  it('fog is ignored', async () => {
    const record = await live({ ...quirky, fog: { enabled: true, type: 'linear', color: 0xffffff, near: 5, far: 60 } } as V0SceneConfig)
    expect(record.scene.fog).toBeNull()
  })

  it('the port lists the assets and what it skipped', async () => {
    const build = await buildV0Scene(structuredClone(quirky), { aspect: 1, loaders: nodeLoaders })
    expect(build.assets).toEqual([
      { kind: 'texture', url: '/mazes/Hallway04/assets/missing.jpg', objectIndex: 5, loaded: false },
      { kind: 'texture', url: '/mazes/Hallway04/assets/Chess_Pattern.jpg', objectIndex: 6, loaded: true }
    ])
    expect(build.diagnostics).toEqual([
      "light type 'hemisphere' is not supported, skipped",
      "object 4 (plane): geometry type 'plane' is not supported, skipped",
      'object 5 (missing texture): texture assets/missing.jpg failed to load, flat colour used: no file for /mazes/Hallway04/assets/missing.jpg under public/'
    ])
    expect(v0Physics(quirky).diagnostics).toEqual(["object 4 (plane): dynamic body without a collider (geometry type 'plane')"])
  })

  it('a skybox that fails to load leaves no background instead of hanging (deviation 1)', async () => {
    const build = await buildV0Scene({ ...quirky, skybox: 'assets/missing.exr' }, { aspect: 1, loaders: nodeLoaders })
    expect(build.scene.background).toBeNull()
    expect(build.scene.environment).toBeNull()
    expect(build.assets[0]).toEqual({ kind: 'skybox', url: '/mazes/Hallway04/assets/missing.exr', objectIndex: null, loaded: false })
    expect(build.diagnostics[0]).toMatch(/^skybox assets\/missing\.exr failed to load, no background \(v0\.3 hangs\)/)
  })
})

it("places the camera rig as v0.3's frame loop does", async () => {
  const build = await buildV0Scene({ objects: [] }, { aspect: 1, loaders: nodeLoaders })
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(0, 1.6, 0)
  const fixedCam = new FixedFollowCam(scene, camera, null, { disableMouseControl: true })
  for (const [x, y, z, theta] of [[0, 0.5, 0, 0], [1.25, 0.5, -30, 0.7], [-19, 0.49, 69.9, -2.5], [3, 2, 1, Number.NaN]]) {
    runV03CameraUpdate(THREE, fixedCam, { x, y, z }, theta)
    placeV0Camera(build.rig, { x, y, z }, theta)
    build.scene.updateMatrixWorld(true)
    scene.updateMatrixWorld(true)
    expect(build.camera.matrixWorld.elements).toEqual(camera.matrixWorld.elements)
  }
})

it("describeScene reports a camera's projection matrix as stored, even when out of date", () => {
  const scene = new THREE.Scene()
  const updated = new THREE.PerspectiveCamera(75, 2, 0.1, 1000)
  const stale = new THREE.PerspectiveCamera()
  Object.assign(stale, { fov: 75, aspect: 2, far: 1000 })   // without updateProjectionMatrix()
  scene.add(updated, stale)
  const [described, staleDescribed] = describeScene(scene, null).children.map(node => node.camera!)
  expect({ ...staleDescribed, projectionMatrix: null }).toEqual({ ...described, projectionMatrix: null })
  expect(staleDescribed.projectionMatrix).not.toEqual(described.projectionMatrix)
})

describe('DOM-free', () => {
  const dir = path.join(REPO_ROOT, 'src', 'compat', 'v0')
  const files = readdirSync(dir).filter(name => name.endsWith('.ts')).map(name => path.join(dir, name))
  const BANNED = /\b(window|document|navigator|location|localStorage|sessionStorage|indexedDB|alert|Image|HTMLElement|HTMLCanvasElement|HTMLImageElement|requestAnimationFrame|cancelAnimationFrame|addEventListener|removeEventListener|getComputedStyle|devicePixelRatio|innerWidth|innerHeight|createElement|createElementNS|TextureLoader|ImageLoader)\b/g

  it('src/compat/v0 names no DOM globals or DOM-bound loaders (comments aside)', () => {
    const found = files.flatMap(file => {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      return [...code.matchAll(BANNED)].map(match => `${path.basename(file)}: ${match[0]}`)
    })
    expect(found).toEqual([])
  })

  it('src/compat/v0 type-checks without the DOM library', () => {
    const shim = path.join(REPO_ROOT, 'src', 'types', 'three-shim.d.ts')
    const program = ts.createProgram([...files, shim], {
      lib: ['lib.es2022.d.ts'], types: [], strict: true, noEmit: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true, allowJs: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true
    } as ts.CompilerOptions)
    const errors = ts.getPreEmitDiagnostics(program)
      .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    expect(errors).toEqual([])
  }, 30_000)
})
