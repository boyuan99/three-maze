// v0.3's own scene loader, taken from the real PythonCustomScene.vue and run in Node: the golden
// snapshots come from it, so the port is compared with what v0.3 actually builds.
//
// Vue's SFC compiler extracts the <script setup> block, and these pieces are located in its syntax
// tree (not by line numbers) and evaluated unchanged:
// - the PLAYER_RADIUS constant and the functions createSceneFromConfig and createPhysicsFromConfig;
// - the setup steps of onMounted, from `await RAPIER.init()` up to (not including) the resize
//   listener: skybox, camera, renderer, lights, meshes, physics world, player body and camera rig;
// - the camera update of animate() (`if (fixedCam) { fixedCam.update(...) }`).
// Their free variables are passed in explicitly. If v0.3 starts using another variable there, the run
// fails with a ReferenceError and the parameter lists below must grow.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { babelParse, parse as parseSfc } from 'vue/compiler-sfc'

export const SCENE_FILE = 'src/scenes/serial/PythonCustomScene.vue'
const scenePath = fileURLToPath(new URL(`../../../${SCENE_FILE}`, import.meta.url))

interface AstNode {
  type: string
  start?: number | null
  end?: number | null
  [key: string]: unknown
}

function* walk(value: unknown): Generator<AstNode> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item)
  } else if (value !== null && typeof value === 'object' && typeof (value as AstNode).type === 'string') {
    yield value as AstNode
    for (const child of Object.values(value)) yield* walk(child)
  }
}

const isNode = (value: unknown, type: string): value is AstNode => (value as AstNode | null)?.type === type
const isIdentifier = (value: unknown, name: string) => isNode(value, 'Identifier') && value.name === name

function only<T>(items: T[], what: string): T {
  if (items.length !== 1) throw new Error(`expected one ${what} in ${SCENE_FILE}, found ${items.length}`)
  return items[0]
}

/** The v0.3 source pieces this file runs, as text */
export function extractV03Loader() {
  const { descriptor, errors } = parseSfc(readFileSync(scenePath, 'utf8'), { filename: scenePath })
  if (errors.length) throw errors[0]
  const block = descriptor.scriptSetup
  if (!block) throw new Error(`no <script setup> block in ${SCENE_FILE}`)
  const source = block.content
  const program = babelParse(source, { sourceType: 'module' }).program as unknown as { body: AstNode[] }
  const nodes = [...walk(program)]
  const text = (node: AstNode) => source.slice(node.start!, node.end!)

  const fn = (name: string) => text(only(program.body.filter(node =>
    node.type === 'FunctionDeclaration' && isIdentifier(node.id, name)), `function ${name}`))
  const playerRadius = only(nodes.filter(node =>
    node.type === 'VariableDeclarator' && isIdentifier(node.id, 'PLAYER_RADIUS')), 'PLAYER_RADIUS')

  // onMounted(async () => { ...; try { <setup> } catch ... })
  const mounted = only(program.body.filter(node => isNode(node, 'ExpressionStatement') &&
    isNode(node.expression, 'CallExpression') && isIdentifier(node.expression.callee, 'onMounted')), 'onMounted call')
  const hook = ((mounted.expression as AstNode).arguments as AstNode[])[0]
  const hookBody = (hook.body as AstNode).body as AstNode[]
  const setupBlock = only(hookBody.filter(node => node.type === 'TryStatement'), 'try block in onMounted')
  const statements = (setupBlock.block as AstNode).body as AstNode[]
  const first = statements.findIndex(node => text(node).startsWith('await RAPIER.init()'))
  const end = statements.findIndex(node => text(node).startsWith("window.addEventListener('resize'"))
  if (first < 0 || end <= first) throw new Error(`onMounted setup steps not found in ${SCENE_FILE}`)
  const setup = source.slice(statements[first].start!, statements[end - 1].end!)

  // animate(): `if (fixedCam) { fixedCam.update({ position: ...bodyPosition..., rotation: ... }) }`
  const animate = only(program.body.filter(node =>
    node.type === 'FunctionDeclaration' && isIdentifier(node.id, 'animate')), 'function animate')
  const cameraUpdate = only([...walk(animate.body)].filter(node => node.type === 'IfStatement' &&
    isIdentifier(node.test, 'fixedCam') && text(node).includes('bodyPosition')), 'per-frame camera update in animate()')

  return {
    playerRadius: `const ${text(playerRadius)}`,
    createSceneFromConfig: fn('createSceneFromConfig'),
    createPhysicsFromConfig: fn('createPhysicsFromConfig'),
    setup,
    cameraUpdate: text(cameraUpdate)
  }
}

/** What runV03Setup's code refers to besides its own declarations */
export interface V03Environment {
  THREE: unknown
  RAPIER: unknown
  EXRLoader: unknown
  FixedFollowCam: unknown
  resolveAssetPath: unknown
  canvas: { value: unknown }
  window: { innerWidth: number, innerHeight: number }
  console: Pick<Console, 'log' | 'warn' | 'error'>
}

/** The objects v0.3's setup leaves behind (three.js and Rapier objects) */
export interface V03Setup {
  scene: any
  camera: any
  renderer: any
  world: any
  fixedCam: any
  playerRigidBody: any
}

type AsyncFactory = new (...parameters: string[]) => (...args: unknown[]) => Promise<unknown>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as AsyncFactory

/** Runs v0.3's scene setup on one scene config, as onMounted does */
export async function runV03Setup(sceneConfig: unknown, env: V03Environment): Promise<V03Setup> {
  const code = extractV03Loader()
  const run = new AsyncFunction(
    'THREE', 'RAPIER', 'EXRLoader', 'FixedFollowCam', 'resolveAssetPath', 'state', 'canvas', 'window', 'console', 'sceneConfig',
    `'use strict'
${code.playerRadius}
${code.createSceneFromConfig}
${code.createPhysicsFromConfig}
${code.setup}
return { scene, camera, renderer, world, fixedCam, playerRigidBody }`)
  const state = { value: { sceneObjects: [] } }
  return await run(env.THREE, env.RAPIER, env.EXRLoader, env.FixedFollowCam, env.resolveAssetPath, state,
    env.canvas, env.window, env.console, sceneConfig) as V03Setup
}

/** Runs v0.3's per-frame camera update for a player body position and heading theta */
export function runV03CameraUpdate(THREE: unknown, fixedCam: unknown, bodyPosition: { x: number, y: number, z: number }, theta: number) {
  const update = new Function('THREE', 'fixedCam', 'bodyPosition', 'position', `'use strict'; ${extractV03Loader().cameraUpdate}`)
  update(THREE, fixedCam, bodyPosition, { value: { theta } })
}
