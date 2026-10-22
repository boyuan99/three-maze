// Render content from a v0 maze JSON (public/mazes/*), built by the v0 reference loader
// (src/compat/v0, plan item TS-28): the render host's first content (REN-9), and the gate's
// fallback scene if the experiment-file compiler is not ready in time.
//
// The scene is v0.3's, quirks included (src/compat/v0/README.md): its meshes, materials, colours
// (colour 0 drawn white), lights and sky. Two things change. The camera is the host's: v0.3's camera
// rig leaves the scene graph, and the host places its own camera at the pose's feet plus the eye
// height, which gives the eye v0.3 used (3.7 above the feet; v0 quirk 7). And the host applies the
// stimulus policy when it is given the content (./renderer.ts): colour textures become sRGB and point
// lights cast no shadows (owner decision D7 a).
import { buildV0Scene, V0_PLAYER } from '../compat/v0/index.ts'
import type { V0AssetLoaders, V0SceneConfig } from '../compat/v0/index.ts'
import type { RenderContent } from './content.ts'

export async function loadV0Content(config: V0SceneConfig, loaders: V0AssetLoaders): Promise<RenderContent> {
  // The aspect ratio does not matter: the host's camera takes its own from the canvas
  const build = await buildV0Scene(config, { aspect: 1, loaders })
  build.scene.remove(build.rig.yaw)
  const [x, centreY, z] = V0_PLAYER.position
  return {
    scene: build.scene,
    projection: { fov: build.camera.fov, near: build.camera.near, far: build.camera.far },
    // v0.3's player is a ball resting on the floor at y = 0, facing -z
    start: { x, feetY: centreY - V0_PLAYER.shape.radius, z, yaw: 0 },
    assets: build.assets.map(asset => ({ kind: asset.kind, url: asset.url, loaded: asset.loaded })),
    diagnostics: [...build.diagnostics],
    source: 'v0'
  }
}
