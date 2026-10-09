// When experiment registration times out, the backend may still finish loading the experiment and
// start it behind the scene's error message. PythonCustomScene.vue then stops it as soon as the late
// reply arrives (stopLateExperiment).
//
// The handler is a closure inside the scene's onMounted hook, so it cannot be imported. The test
// takes it from the real .vue source: Vue's SFC compiler extracts the <script setup> block, the
// handler is located in its syntax tree (not by text position or indentation), and it is evaluated
// with its free variables (experimentFile, backendClient) passed in explicitly. If the handler starts
// using another variable of the scene, the test fails with a ReferenceError and must be extended.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { babelParse, parse as parseSfc } from 'vue/compiler-sfc'
import { connectedClient } from './fakeBackend.ts'

const scenePath = fileURLToPath(new URL('../../src/scenes/serial/PythonCustomScene.vue', import.meta.url))

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
const isString = (value: unknown, text: string) => isNode(value, 'StringLiteral') && value.value === text
const contains = (outer: AstNode, inner: AstNode) => outer.start! <= inner.start! && inner.end! <= outer.end!

/** The scene's script: its syntax-tree nodes and the source text of a node. */
function readSceneScript() {
  const { descriptor, errors } = parseSfc(readFileSync(scenePath, 'utf8'), { filename: scenePath })
  if (errors.length) throw errors[0]
  const block = descriptor.scriptSetup ?? descriptor.script
  if (!block) throw new Error(`no <script> block in ${scenePath}`)
  const source = block.content
  const ast = babelParse(source, { sourceType: 'module', plugins: block.lang === 'ts' ? ['typescript'] : [] })
  return { nodes: [...walk(ast.program)], text: (node: AstNode) => source.slice(node.start!, node.end!) }
}

function findStopLateExperiment(nodes: AstNode[]) {
  const declarators = nodes.filter(node => node.type === 'VariableDeclarator' && isIdentifier(node.id, 'stopLateExperiment'))
  expect(declarators, 'one stopLateExperiment declaration in PythonCustomScene.vue').toHaveLength(1)
  return declarators[0]
}

type Handler = (data: unknown) => void

/** The scene's stopLateExperiment, bound to the given scene variables. */
function loadStopLateExperiment(experimentFile: { value: string }, backendClient: unknown): Handler {
  const { nodes, text } = readSceneScript()
  // `stopLateExperiment = (data) => { ... }`: the handler refers to itself to unsubscribe
  const declarator = text(findStopLateExperiment(nodes))
  const factory = new Function('experimentFile', 'backendClient', `'use strict'; const ${declarator}; return stopLateExperiment`)
  return factory(experimentFile, backendClient) as Handler
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PythonCustomScene: experiment registered after a registration timeout', () => {
  it('listens for the late reply only after a TIMEOUT failure', () => {
    const { nodes, text } = readSceneScript()
    const declaration = findStopLateExperiment(nodes)
    const timeoutBranches = nodes.filter(node => node.type === 'IfStatement' && isNode(node.test, 'BinaryExpression') &&
      node.test.operator === '===' && isNode(node.test.left, 'MemberExpression') &&
      isIdentifier(node.test.left.property, 'code') && isString(node.test.right, 'TIMEOUT'))
    const registrations = nodes.filter(node => node.type === 'CallExpression' && isNode(node.callee, 'MemberExpression') &&
      text(node.callee) === 'backendClient.on' && Array.isArray(node.arguments) &&
      isString(node.arguments[0], 'experiment_registered') && isIdentifier(node.arguments[1], 'stopLateExperiment'))
    expect(timeoutBranches, "one `if (err.code === 'TIMEOUT')` branch").toHaveLength(1)
    expect(registrations, "one backendClient.on('experiment_registered', stopLateExperiment)").toHaveLength(1)
    const branch = timeoutBranches[0].consequent as AstNode
    expect(contains(branch, declaration)).toBe(true)
    expect(contains(branch, registrations[0])).toBe(true)
  })

  it('sends one experiment_stop for the late reply and ignores replies for other files', async () => {
    vi.useFakeTimers()
    const { client, sent, reply } = connectedClient()
    const experimentFile = { value: 'hallway02_experiment.py' }
    const failure = client.request('experiment_register', { filename: experimentFile.value }, 50)
      .then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    expect(await failure).toHaveProperty('code', 'TIMEOUT')

    const stopLateExperiment = loadStopLateExperiment(experimentFile, client)
    client.on('experiment_registered', stopLateExperiment)  // as the scene does (previous test)
    const requestId = sent[0].requestId
    const stops = () => sent.filter(message => message.type === 'experiment_stop')

    reply('experiment_registered', { filename: 'other.py' }, 99)
    expect(stops()).toHaveLength(0)
    reply('experiment_registered', { filename: 'hallway02_experiment.py' }, requestId)
    reply('experiment_registered', { filename: 'hallway02_experiment.py' }, requestId)
    expect(stops()).toHaveLength(1)
    expect(stops()[0].data).toEqual({})
  })
})
