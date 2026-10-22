// The declarative task vocabulary (schema/vocabulary.json, ADR-0005 F5) and its CI check
// (tools/vocabulary/): within ADR-0002's budget of 12 actions and 6 event categories, phase 2
// included, and failing over budget (ADR-0002 Validation 4); generated files up to date; names as
// the backend design gives them; ADR-0005's example written with them.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  actionFormProblem, BUDGET, checkVocabulary, OUTPUT_PATHS, pythonName, readVocabulary,
  renderOutputs, VOCABULARY_PATH, type Vocabulary
} from '../../tools/vocabulary/vocabulary.ts'
import {
  ACTION_OPERATIONS, ACTIONS, EVENT_CATEGORIES, FORMER_ACTION_NAMES, FORMER_EVENT_NAMES,
  IDENTIFIER_PATTERN, PHASE1_ACTIONS, PHASE1_EVENT_CATEGORIES, PHASE1_EVENT_PATTERN,
  RESERVED_ACTIONS, RESERVED_EVENT_CATEGORIES
} from '../../src/task/vocabulary.generated.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// As committed: git may check text files out with CRLF line ends
const read = (relative: string) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n')
const vocabularyJson = (): Vocabulary => JSON.parse(read(VOCABULARY_PATH))

// The over-budget fixtures: the real vocabulary plus one more action or event category
function withExtraAction(): Vocabulary {
  const v = vocabularyJson()
  // The backend design's generic output verb (backend-modules.md:345), the likeliest 13th action
  v.actions.push({ name: 'output', phase: 2, summary: 'Drive an output role, e.g. a trigger pulse.' })
  return v
}
function withExtraCategory(): Vocabulary {
  const v = vocabularyJson()
  v.eventCategories.push({ name: 'fall', phase: 2, form: 'fall:<edge>', summary: 'A fall started.' })
  return v
}

describe('budget (ADR-0002, Risk and Validation 4)', () => {
  it('the vocabulary has no problem and is within the budget, phase 2 included', () => {
    const v = vocabularyJson()
    expect(checkVocabulary(v)).toEqual([])
    expect(BUDGET).toEqual({ actions: 12, eventCategories: 6 })
    expect(v.actions.length).toBeLessThanOrEqual(BUDGET.actions)
    expect(v.eventCategories.length).toBeLessThanOrEqual(BUDGET.eventCategories)
  })

  it('a 13th action fails the check and stops the generator', () => {
    const problems = checkVocabulary(withExtraAction())
    expect(problems).toEqual([
      expect.stringMatching(/^\/actions: 13 actions, phase 2 included, exceed ADR-0002's budget of 12/)
    ])
    expect(() => renderOutputs(withExtraAction())).toThrow(/budget of 12/)
  })

  it('a 7th event category fails the check', () => {
    expect(checkVocabulary(withExtraCategory())).toEqual([
      expect.stringMatching(/^\/eventCategories: 7 event categories, .* budget of 6/)
    ])
  })

  it('the command line exits 0 on the repository and 1 on an over-budget vocabulary', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [
      '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
      'tools/vocabulary/generate.ts', ...args
    ], { cwd: ROOT, encoding: 'utf8' })
    const ok = run('--check')
    expect(ok.stderr).toBe('')
    expect(ok.status).toBe(0)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocabulary-'))
    try {
      const file = path.join(dir, 'vocabulary.json')
      fs.writeFileSync(file, JSON.stringify(withExtraAction()))
      const over = run('--check', '--vocabulary', file)
      expect(over.status).toBe(1)
      expect(over.stderr).toMatch(/13 actions, phase 2 included, exceed ADR-0002's budget of 12/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('generated files', () => {
  it('match the vocabulary (otherwise run `npm run vocabulary`)', () => {
    const outputs = renderOutputs(vocabularyJson())
    expect([...outputs.keys()].sort()).toEqual(Object.values(OUTPUT_PATHS).sort())
    for (const [relative, text] of outputs) {
      expect(read(relative), `${relative} is stale: run \`npm run vocabulary\``).toBe(text)
    }
  })

  it('carry the same names as the vocabulary', () => {
    const v = vocabularyJson()
    const phase = (p: 1 | 2) => v.actions.filter(a => a.phase === p).map(a => a.name)
    expect(Object.keys(ACTIONS)).toEqual(v.actions.map(a => a.name))
    expect(PHASE1_ACTIONS).toEqual(phase(1))
    expect(RESERVED_ACTIONS).toEqual(phase(2))
    expect(EVENT_CATEGORIES).toEqual(v.eventCategories.map(c => c.name))
    expect([...PHASE1_EVENT_CATEGORIES, ...RESERVED_EVENT_CATEGORIES]).toEqual([...EVENT_CATEGORIES])
    for (const [name, { python }] of Object.entries(ACTIONS)) expect(python).toBe(pythonName(name))
  })

  it('give patterns that accept the ids and events of format 1.0 and nothing else', () => {
    const id = new RegExp(IDENTIFIER_PATTERN, 'u')
    for (const good of ['a', 'start', 'endNorth', 'A1_b']) expect(id.test(good), good).toBe(true)
    for (const bad of ['', '1a', '_a', 'a-b', 'a.b', '@a', 'a b', 'é', 'a\n']) {
      expect(id.test(bad), JSON.stringify(bad)).toBe(false)
    }
    const event = new RegExp(PHASE1_EVENT_PATTERN, 'u')
    for (const good of ['enter:endNorth', 'exit:endSouth', 'timer:iti']) {
      expect(event.test(good), good).toBe(true)
    }
    // enter:@tag is phase 2 (ADR-0005 F10); input, message and world are reserved categories
    const bad = ['enter:@reward', 'enter:', 'enter', 'input:lick', 'world:switched', 'zone_enter:a', 'Enter:a']
    for (const e of bad) expect(event.test(e), e).toBe(false)
  })
})

describe('names', () => {
  it('follow the backend design (backend-modules.md:74-77) and the merges of ADR-0005 F5', () => {
    expect(EVENT_CATEGORIES).toEqual(['enter', 'exit', 'timer', 'input', 'message', 'world'])
    expect(PHASE1_ACTIONS).toEqual([
      'reward', 'teleport', 'freeze', 'display', 'timer', 'trial', 'set', 'endSession'
    ])
    expect(RESERVED_ACTIONS).toEqual(['setGain', 'setCue', 'emit', 'switchWorld'])
    expect(ACTION_OPERATIONS).toEqual({
      display: ['blank', 'on'], timer: ['start', 'cancel'], trial: ['start', 'end']
    })
    expect(FORMER_ACTION_NAMES).toMatchObject({
      startTimer: 'timer', endTrial: 'trial', lock_motion: 'freeze', water: 'reward'
    })
    expect(FORMER_EVENT_NAMES).toEqual({ zone_enter: 'enter', zone_exit: 'exit' })
    expect(pythonName('endSession')).toBe('end_session')
    expect(pythonName('switchWorld')).toBe('switch_world')
  })

  it('the checker rejects malformed entries, each at its JSON pointer', () => {
    const v = vocabularyJson()
    v.actions[0]!.examples = [{ reward: {}, extra: 1 }]
    v.actions[3]!.operations = ['blank']
    v.actions[3]!.examples = [{ display: 'blank' }]
    v.actions[4]!.examples = [{ timer: { start: 'a', cancel: 'a' } }]
    v.actions[5]!.examples = [{ trial: 'pause' }]
    v.actions[6]!.pending = 'phase-1 names wait for nothing'
    v.actions[7]!.formerNames = ['reward']
    v.actions[9]!.name = 'setgain'
    v.actions[10]!.name = 'pass'
    v.actions[11]!.examples = [{ switchWorld: 'B' }]
    v.eventCategories[2]!.form = 'clock:<timer>'
    const problems = checkVocabulary(v)
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\/actions\/0\/examples\/0: must be an object with the single key "reward"/),
      expect.stringMatching(/^\/actions\/3\/operations: must list at least two distinct lowercase/),
      expect.stringMatching(/^\/actions\/4\/examples\/0: must give exactly one operation/),
      expect.stringMatching(/^\/actions\/5\/examples\/0: "pause" is not an operation/),
      expect.stringMatching(/^\/actions\/6\/pending: only a phase-2 name/),
      expect.stringMatching(/^\/actions\/7\/formerNames\/0: "reward" is a current name/),
      expect.stringMatching(/^\/actions\/9\/name: "setgain" repeats \/actions\/8\/name/),
      expect.stringMatching(/^\/actions\/10\/name: its Python name "pass" is a Python keyword/),
      expect.stringMatching(/^\/actions\/11\/examples: a reserved action has no examples/),
      expect.stringMatching(/^\/eventCategories\/2\/form: must start with "timer:"/)
    ]))
    expect(problems).toHaveLength(10)
  })
})

describe('ADR-0005', () => {
  interface Experiment { task: { stateMachine: { states: Record<string, Record<string, unknown>> } } }

  // The actions of every state's entry and exit and of every transition's do, in on and always;
  // and the event names of every on
  function actionsAndEvents(experiment: Experiment) {
    const actions: unknown[] = []
    const events: string[] = []
    const transitions = (list: unknown) => {
      for (const t of list as { do?: unknown[] }[]) actions.push(...(t.do ?? []))
    }
    for (const state of Object.values(experiment.task.stateMachine.states)) {
      actions.push(...((state.entry as unknown[]) ?? []), ...((state.exit as unknown[]) ?? []))
      for (const [event, list] of Object.entries((state.on as Record<string, unknown>) ?? {})) {
        events.push(event)
        transitions(list)
      }
      transitions(state.always ?? [])
    }
    return { actions, events }
  }

  it('writes its example with the vocabulary of format 1.0', () => {
    const block = read('docs/adr/0005-experiment-file-format.md').match(/```json\n([\s\S]*?)\n```/)
    expect(block).not.toBeNull()
    const experiment = JSON.parse(block![1]!)
    expect(experiment).toMatchObject({
      format: 'three-maze-experiment', version: '1.0', units: { length: 'cm' }
    })
    const { actions, events } = actionsAndEvents(experiment)
    const v = readVocabulary(vocabularyJson())
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) expect(actionFormProblem(v, action), JSON.stringify(action)).toBeNull()
    const event = new RegExp(PHASE1_EVENT_PATTERN, 'u')
    for (const e of events) expect(event.test(e), e).toBe(true)
  })

  it('lists the actions of the vocabulary in its F5 table, in the same order', () => {
    const adr = read('docs/adr/0005-experiment-file-format.md')
    const start = adr.indexOf('| Action | Form |')
    expect(start).toBeGreaterThan(-1)
    const table = adr.slice(start, adr.indexOf('\n\n', start))
    const names = [...table.matchAll(/^\| `(\w+)` \|/gm)].map(m => m[1])
    expect(names).toEqual(vocabularyJson().actions.map(a => a.name))
  })

  it('names unknown, former and reserved actions in the diagnostic', () => {
    const v = readVocabulary(vocabularyJson())
    const problem = (action: unknown) => actionFormProblem(v, action)
    expect(problem({ startTimer: { id: 'iti', duration: 2 } })).toBe('unknown action "startTimer" (now "timer")')
    expect(problem({ jump: {} })).toBe('unknown action "jump"')
    expect(problem({ switchWorld: { world: 'B' } })).toBe('"switchWorld" is reserved for a later version')
    expect(problem({ trial: 'pause' })).toBe('"pause" is not an operation')
    expect(problem({ freeze: true, display: 'blank' })).toBe('an action is an object with one key')
  })
})
