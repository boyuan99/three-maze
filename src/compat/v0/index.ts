// The v0 reference loader: v0.3's experiment scene (src/scenes/serial/PythonCustomScene.vue) built
// without the DOM. See README.md for what it reproduces, its quirks and how it is tested.
export type * from './config.ts'
export { buildV0Scene, placeV0Camera, V0_CAMERA, V0_CAMERA_HEIGHT_IN_RIG, V0_DEFAULT_LIGHTS, V0_POINT_LIGHT, V0_RIG_HEIGHT } from './scene.ts'
export type { V0Asset, V0AssetLoaders, V0BuildOptions, V0CameraRig, V0SceneBuild } from './scene.ts'
export { v0Physics, V0_GRAVITY, V0_PLAYER } from './physics.ts'
export type { Quat, V0BodyType, V0BodyWithoutCollider, V0PhysicsBuild, V0PlayerBody, V0Shape, V0Solid, Vec3 } from './physics.ts'
export { createV0Renderer, V0_RENDERER_PARAMETERS } from './renderer.ts'
export type { V0RendererOptions } from './renderer.ts'
export { describeScene } from './describe.ts'
export type { DescribeOptions, NodeDescription, SceneDescription, TextureDescription } from './describe.ts'
