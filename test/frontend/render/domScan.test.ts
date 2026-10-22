// The render host stays free of the DOM (ADR-0003 Decision 1c and Validation 3's lint rule; plan item
// REN-9), so the same code can draw in the scene window and in a worker:
// - a scan of the identifiers in src/render and in every file it imports, for the window, the
//   document, their elements and events, DOM-bound loaders and the window's frame timer;
// - a check of what src/render imports: three, its EXR loader, and DOM-free modules of this project;
// - the type check of src/render/tsconfig.json (ES2022 and WebWorker libraries, no DOM), run by
//   `npm run typecheck`: it passes, and it fails on a fixture that names the document or the window.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../v0Reference/harness.ts'

const RENDER_DIR = path.join(REPO_ROOT, 'src', 'render')
const relative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/')

/** Names the render host must not use, even where a worker has them (requestAnimationFrame, self) */
const BANNED = new Set([
  // the window and the document
  'window', 'document', 'globalThis', 'self', 'navigator', 'location', 'history', 'screen', 'localStorage',
  'sessionStorage', 'indexedDB', 'alert', 'confirm', 'prompt', 'matchMedia', 'getComputedStyle',
  'devicePixelRatio', 'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight',
  // elements, their creation and their events
  'Image', 'HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'HTMLVideoElement', 'createElement',
  'createElementNS', 'addEventListener', 'removeEventListener', 'MutationObserver', 'ResizeObserver',
  'IntersectionObserver', 'domElement',
  // the frame timer and messaging belong to whoever runs the host (they are passed in)
  'requestAnimationFrame', 'cancelAnimationFrame', 'postMessage', 'onmessage', 'importScripts',
  // three's loaders that decode through an <img>
  'TextureLoader', 'ImageLoader', 'CubeTextureLoader'
])

/** Every source file of the src/render program outside node_modules: src/render and what it imports */
function projectFiles(program: ts.Program) {
  return program.getSourceFiles().map(file => file.fileName).filter(name => !name.includes('/node_modules/'))
}

function renderConfig() {
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(RENDER_DIR, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    }
  })
  if (!parsed) throw new Error('src/render/tsconfig.json could not be read')
  return parsed
}

/** The program `tsc -p src/render` checks, optionally with one more file that exists only here */
function renderProgram(extra?: { fileName: string, text: string }) {
  const parsed = renderConfig()
  const host = ts.createCompilerHost(parsed.options)
  if (extra) {
    const { getSourceFile, fileExists, readFile } = host
    const same = (name: string) => path.resolve(name) === path.resolve(extra.fileName)
    host.getSourceFile = (name, languageVersion, ...rest) => same(name)
      ? ts.createSourceFile(name, extra.text, languageVersion, true)
      : getSourceFile.call(host, name, languageVersion, ...rest)
    host.fileExists = name => same(name) || fileExists.call(host, name)
    host.readFile = name => same(name) ? extra.text : readFile.call(host, name)
  }
  const rootNames = extra ? [...parsed.fileNames, extra.fileName] : parsed.fileNames
  return ts.createProgram({ rootNames, options: parsed.options, host })
}

const messages = (diagnostics: readonly ts.Diagnostic[]) => diagnostics.map(diagnostic =>
  `${diagnostic.file ? relative(diagnostic.file.fileName) : ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)

describe('render host without the DOM', () => {
  const program = renderProgram()
  const files = projectFiles(program)

  it('covers src/render and the modules it imports', () => {
    const names = files.map(relative)
    for (const expected of ['src/render/RenderHost.ts', 'src/render/renderer.ts', 'src/render/loaders.ts',
      'src/render/content.ts', 'src/render/v0Content.ts', 'src/render/index.ts', 'src/compat/v0/scene.ts',
      'src/motion/core.ts', 'src/utils/resolveAssetPath.js']) {
      expect(names).toContain(expected)
    }
  })

  it('names nothing of the window, the document, DOM events or the frame timer (comments and strings aside)', () => {
    const found: string[] = []
    for (const file of files) {
      // Every identifier of the syntax tree: names, property names, types; not comments or strings
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && BANNED.has(node.text)) found.push(`${relative(file)}: ${node.text}`)
        ts.forEachChild(node, visit)
      }
      visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true))
    }
    expect(found).toEqual([])
  })

  it('imports only three, its EXR loader and DOM-free modules (no Vue, no app modules)', () => {
    const allowedPackages = ['three', 'three/examples/jsm/loaders/EXRLoader.js']
    const allowedFolders = ['src/render/', 'src/compat/v0/']
    const allowedFiles = ['src/motion/core.ts', 'src/utils/resolveAssetPath.js']
    const found: string[] = []
    for (const file of files.filter(name => relative(name).startsWith('src/render/'))) {
      for (const { fileName: specifier } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
        if (allowedPackages.includes(specifier)) continue
        const target = specifier.startsWith('.') ? relative(path.resolve(path.dirname(file), specifier)) : null
        if (target && (allowedFolders.some(folder => target.startsWith(folder)) || allowedFiles.includes(target))) continue
        found.push(`${relative(file)}: ${specifier}`)
      }
    }
    expect(found).toEqual([])
  })

  it('type-checks with src/render/tsconfig.json: ES2022 and WebWorker, no DOM', () => {
    const options = program.getCompilerOptions()
    expect(options.lib).toEqual(['lib.es2022.d.ts', 'lib.webworker.d.ts'])
    expect(options.types).toEqual([])
    expect(messages(ts.getPreEmitDiagnostics(program))).toEqual([])
  }, 60_000)

  it('fails that type check when src/render names the document, the window or an HTML element (fixture)', () => {
    const fixture = {
      fileName: path.join(RENDER_DIR, '__domFixture__.ts'),
      text: [
        'export const title = document.title',
        'export const ratio = window.devicePixelRatio',
        'export const element: HTMLCanvasElement | null = null',
        'export const pixels = devicePixelRatio'
      ].join('\n')
    }
    const errors = messages(ts.getPreEmitDiagnostics(renderProgram(fixture)))
    expect(errors).toEqual([
      expect.stringMatching(/^src\/render\/__domFixture__\.ts: Cannot find name 'document'/),
      "src/render/__domFixture__.ts: Cannot find name 'window'.",
      "src/render/__domFixture__.ts: Cannot find name 'HTMLCanvasElement'.",
      "src/render/__domFixture__.ts: Cannot find name 'devicePixelRatio'."
    ])
  }, 60_000)

  it('is part of npm run typecheck', () => {
    const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts
    expect(scripts.typecheck).toMatch(/tsc --noEmit -p src\/render\b/)
  })
})
