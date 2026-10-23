// Render content from the v0 reference loader (src/render/v0Content.ts): the six shipped mazes as
// v0.3 builds them, without v0.3's camera rig, through the render host on a stand-in renderer.
import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildV0Scene, describeScene, placeV0Camera, V0_PLAYER } from '../../../src/compat/v0/index.ts'
import type { V0SceneConfig } from '../../../src/compat/v0/index.ts'
import { createRenderHost, loadV0Content } from '../../../src/render/index.ts'
import { fetchFromPublic, nodeLoaders, readMaze, shippedMazes } from '../v0Reference/harness.ts'
import { fakeRendererClass } from './fakeRenderer.ts'

beforeAll(() => {
  vi.stubGlobal('fetch', fetchFromPublic)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

const mazes = shippedMazes()

function hostFor() {
  const { FakeWebGLRenderer } = fakeRendererClass()
  const canvas = { width: 300, height: 150 } as unknown as OffscreenCanvas
  return createRenderHost({ canvas, width: 1920, height: 1080, pixelRatio: 1, WebGLRenderer: FakeWebGLRenderer })
}

it('covers the six shipped mazes', () => {
  expect(mazes.map(maze => maze.name)).toEqual(['Example01', 'Hallway01', 'Hallway02', 'Hallway04', 'HallwaySerialMigrated', 'Hallway_fog'])
})

describe.each(mazes)('$name', maze => {
  it("holds v0.3's scene graph without v0.3's camera rig", async () => {
    const config = readMaze(maze)
    const build = await buildV0Scene(structuredClone(config), { aspect: 1, loaders: nodeLoaders })
    const content = await loadV0Content(structuredClone(config), nodeLoaders)

    const expected = describeScene(build.scene, null)
    const rig = expected.children.pop()!
    expect(rig.type).toBe('Object3D') // yaw > pitch > camera, added last (src/compat/v0/scene.ts)
    expect(rig.children[0]!.children[0]!.type).toBe('PerspectiveCamera')
    expect(describeScene(content.scene, null)).toEqual(expected)
    expect(content.scene.getObjectsByProperty('isCamera', true)).toEqual([])

    expect(content.projection).toEqual({ fov: config.camera?.fov || 75, near: 0.1, far: 1000 })
    expect(content.start).toEqual({ x: 0, feetY: 0, z: 0, yaw: 0 })
    expect(content.assets).toEqual(build.assets.map(({ kind, url, loaded }) => ({ kind, url, loaded })))
    expect(content.assets.every(asset => asset.loaded)).toBe(true)
    expect(content.diagnostics).toEqual(build.diagnostics)
    expect(content.source).toBe('v0')
  })

  it("keeps v0.3's colours and lights; the host makes colour textures sRGB and stops point-light shadows", async () => {
    const config: V0SceneConfig = readMaze(maze)
    const content = await loadV0Content(structuredClone(config), nodeLoaders)
    const h = hostFor()
    const policy = h.setContent(content)

    const objects = config.objects ?? []
    const meshes = content.scene.children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh)
    expect(meshes).toHaveLength(objects.length)
    meshes.forEach((mesh, i) => {
      const material = mesh.material as THREE.MeshStandardMaterial
      // v0.3's `||` default: colour 0 and no colour are both drawn white (v0 quirk 3)
      expect(material.color.getHex()).toBe(objects[i]!.material?.color || 0xffffff)
      if (objects[i]!.material?.map) expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace)
      else expect(material.map).toBeNull()
    })
    const pointShadowsAsked = (config.lights ?? []).filter(light => light.type === 'point' && light.castShadow).length
    expect(policy).toEqual({ colorMaps: objects.filter(object => object.material?.map).length, pointLightShadowsOff: pointShadowsAsked })
    const lights = content.scene.children.filter((child): child is THREE.Light => (child as THREE.Light).isLight)
    expect(lights.filter(light => (light as THREE.PointLight).isPointLight && light.castShadow)).toEqual([])
    expect(lights.map(light => [light.type, light.color.getHex(), light.intensity]))
      .toEqual((config.lights ?? []).map(light => [
        { ambient: 'AmbientLight', directional: 'DirectionalLight', point: 'PointLight' }[light.type], light.color, light.intensity
      ]))
    // The sky stays linear: it is not a colour texture of a material
    if (config.skybox) {
      expect((content.scene.background as THREE.Texture).colorSpace).not.toBe(THREE.SRGBColorSpace)
      expect(content.scene.environment).toBe(content.scene.background)
    }
  })
})

it("shows v0.3's view: the host's camera for a pose is v0.3's camera for the same body", async () => {
  const build = await buildV0Scene({ objects: [] }, { aspect: 1920 / 1080, loaders: nodeLoaders })
  const h = hostFor()
  h.setContent(await loadV0Content({ objects: [] }, nodeLoaders))
  const radius = V0_PLAYER.shape.radius
  for (const [x, feetY, z, yaw] of [[0, 0, 0, 0], [1.25, 0, -30, 0.7], [-19, 0, 69.9, -2.5], [3, 7.25, 1, 3.1]]) {
    // v0.3 places its rig at the player ball's centre, a radius above the feet (:231-240)
    placeV0Camera(build.rig, { x, y: feetY + radius, z }, yaw)
    build.scene.updateMatrixWorld(true)
    h.setPose({ seq: 1, epoch: 0, t_dev_us: 0, x, feetY, z, yaw })
    h.renderFrame()
    const v03 = { position: build.camera.getWorldPosition(new THREE.Vector3()), quaternion: build.camera.getWorldQuaternion(new THREE.Quaternion()) }
    const ours = { position: h.camera.getWorldPosition(new THREE.Vector3()), quaternion: h.camera.getWorldQuaternion(new THREE.Quaternion()) }
    expect(ours.position.distanceTo(v03.position)).toBeLessThan(1e-12)
    expect(Math.abs(ours.quaternion.dot(v03.quaternion))).toBeCloseTo(1, 12)
    expect([h.camera.fov, h.camera.near, h.camera.far]).toEqual([build.camera.fov, build.camera.near, build.camera.far])
  }
})
