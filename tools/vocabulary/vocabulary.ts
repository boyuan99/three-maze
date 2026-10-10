// The declarative task vocabulary (ADR-0005 F5): checks schema/vocabulary.json and renders the
// files generated from it, so that the experiment schema, the TypeScript task code and the Python
// code share one list of names. generate.ts writes or checks the files;
// test/frontend/vocabulary.test.ts fails CI when the list exceeds ADR-0002's budget or a generated
// file is stale.
//
// No file system access here: the functions take the parsed JSON and return text.

/**
 * ADR-0002, Consequences (Risk): the format keeps within 12 declarative actions and 6 task-event
 * categories; "a CI check fails over budget, and raising it needs an ADR". Phase 2 extends the
 * same format, so its reserved names count too (ADR-0005 F5). Change these numbers only together
 * with that ADR.
 */
export const BUDGET = { actions: 12, eventCategories: 6 } as const

/** 1: accepted by format 1.0; 2: the name is reserved and rejected until a later version. */
export type Phase = 1 | 2

export interface Action {
  name: string
  phase: Phase
  summary: string
  /** Operations of a merged action, e.g. timer start|cancel (ADR-0005 F5). */
  operations?: string[]
  /** Complete action objects as an experiment file writes them (phase 1 only). */
  examples?: unknown[]
  /** Names from v0.3, the designs and the prototypes that this action replaces. */
  formerNames?: string[]
  /** The open decision that may move a phase-2 name into phase 1. */
  pending?: string
}

export interface EventCategory {
  name: string
  phase: Phase
  /** How an event of this category is written, e.g. `enter:<zone>`. */
  form: string
  summary: string
  formerNames?: string[]
  pending?: string
}

export interface Vocabulary {
  identifier: string
  actions: Action[]
  eventCategories: EventCategory[]
}

export const VOCABULARY_PATH = 'schema/vocabulary.json'

/** Paths of the generated files, relative to the repository root. */
export const OUTPUT_PATHS = {
  schema: 'schema/generated/vocabulary.schema.json',
  typescript: 'src/task/vocabulary.generated.ts',
  python: 'threemaze/core/vocabulary.py'
} as const

const GENERATED_BY = `Generated from ${VOCABULARY_PATH} by \`npm run vocabulary\` ` +
  '(tools/vocabulary/generate.ts)'

// Action names are camelCase in JSON (ADR-0005 F4); event categories and operations are one
// lowercase word, the same in JSON and Python
const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/
const LOWER_WORD = /^[a-z][a-z0-9]*$/
// Former names become property names in the generated TypeScript and Python
const FORMER_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

// Python's keywords (Python 3.12, keyword.kwlist): no Python name may be one of them
const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'
])

const TOP_KEYS = new Set(['$comment', 'identifier', 'actions', 'eventCategories'])
const ACTION_KEYS = new Set([
  'name', 'phase', 'summary', 'operations', 'examples', 'formerNames', 'pending'
])
const CATEGORY_KEYS = new Set(['name', 'phase', 'form', 'summary', 'formerNames', 'pending'])

/** The Python name of a JSON name: camelCase to snake_case (`endSession` -> `end_session`). */
export function pythonName(name: string): string {
  return name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isStringList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(s => typeof s === 'string')

/** The body of an anchored pattern `^...$`, for building longer patterns from it. */
const patternBody = (pattern: string) => pattern.slice(1, -1)

/**
 * Every problem with a parsed vocabulary file, each as "<JSON pointer>: <message>"; empty when the
 * file is well formed, its names follow ADR-0005 and it is within ADR-0002's budget.
 */
export function checkVocabulary(value: unknown): string[] {
  const problems: string[] = []
  const add = (pointer: string, message: string) => { problems.push(`${pointer || '/'}: ${message}`) }
  if (!isObject(value)) return ['/: the vocabulary must be a JSON object']
  for (const key of Object.keys(value)) if (!TOP_KEYS.has(key)) add(`/${key}`, 'unknown key')

  let identifier: RegExp | null = null
  const pattern = value.identifier
  if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$')) {
    add('/identifier', 'must be a pattern anchored with ^ and $')
  } else {
    try {
      identifier = new RegExp(pattern, 'u')
    } catch (err) {
      add('/identifier', `not a valid regular expression: ${(err as Error).message}`)
    }
  }

  // Names are compared without letter case, so that no two differ only in case; actions and event
  // categories are separate namespaces (`timer` is both). Former names share one namespace.
  const current = new Map<string, string>() // "<kind>:<lower-case name>" -> pointer
  const former = new Map<string, string>() // former name -> pointer
  const claim = (pointer: string, name: string, kind: 'action' | 'category') => {
    const key = `${kind}:${name.toLowerCase()}`
    const earlier = current.get(key)
    if (earlier) add(pointer, `"${name}" repeats ${earlier} (names must differ in more than case)`)
    else current.set(key, pointer)
  }
  const checkFormerNames = (pointer: string, list: unknown) => {
    if (list === undefined) return
    if (!isStringList(list)) { add(pointer, 'must be a list of strings'); return }
    list.forEach((name, i) => {
      if (!FORMER_NAME.test(name)) add(`${pointer}/${i}`, `"${name}" must match ${FORMER_NAME.source}`)
      const earlier = former.get(name)
      if (earlier) add(`${pointer}/${i}`, `"${name}" is already a former name at ${earlier}`)
      else former.set(name, `${pointer}/${i}`)
    })
  }
  const checkCommon = (pointer: string, entry: Record<string, unknown>) => {
    if (entry.phase !== 1 && entry.phase !== 2) add(`${pointer}/phase`, 'must be 1 or 2')
    if (typeof entry.summary !== 'string' || entry.summary.trim() === '') {
      add(`${pointer}/summary`, 'must be a non-empty string')
    }
    if (entry.pending !== undefined) {
      if (typeof entry.pending !== 'string' || entry.pending.trim() === '') {
        add(`${pointer}/pending`, 'must be a non-empty string')
      } else if (entry.phase !== 2) {
        add(`${pointer}/pending`, 'only a phase-2 name can wait for a decision')
      }
    }
  }

  const actions = value.actions
  if (!Array.isArray(actions)) {
    add('/actions', 'must be a list')
  } else {
    actions.forEach((entry, i) => {
      const p = `/actions/${i}`
      if (!isObject(entry)) { add(p, 'must be an object'); return }
      for (const key of Object.keys(entry)) if (!ACTION_KEYS.has(key)) add(`${p}/${key}`, 'unknown key')
      checkCommon(p, entry)
      checkFormerNames(`${p}/formerNames`, entry.formerNames)
      const name = entry.name
      if (typeof name !== 'string' || !CAMEL_CASE.test(name) || (identifier && !identifier.test(name))) {
        add(`${p}/name`, 'must be a camelCase name (ADR-0005 F4)')
        return
      }
      claim(`${p}/name`, name, 'action')
      if (PYTHON_KEYWORDS.has(pythonName(name))) {
        add(`${p}/name`, `its Python name "${pythonName(name)}" is a Python keyword`)
      }
      const ops = entry.operations
      if (ops !== undefined && (!isStringList(ops) || ops.length < 2 ||
        new Set(ops).size !== ops.length || !ops.every(op => LOWER_WORD.test(op)))) {
        add(`${p}/operations`, 'must list at least two distinct lowercase words')
      }
      const examples = entry.examples
      if (entry.phase === 1 && (!Array.isArray(examples) || examples.length === 0)) {
        add(`${p}/examples`, 'a phase-1 action needs at least one example')
      } else if (entry.phase === 2 && examples !== undefined) {
        add(`${p}/examples`, 'a reserved action has no examples: its form is decided when it is accepted')
      } else if (Array.isArray(examples)) {
        examples.forEach((example, k) => {
          const problem = exampleProblem(name, isStringList(ops) ? ops : undefined, example)
          if (problem) add(`${p}/examples/${k}`, problem)
        })
      }
    })
  }

  const categories = value.eventCategories
  if (!Array.isArray(categories)) {
    add('/eventCategories', 'must be a list')
  } else {
    categories.forEach((entry, i) => {
      const p = `/eventCategories/${i}`
      if (!isObject(entry)) { add(p, 'must be an object'); return }
      for (const key of Object.keys(entry)) if (!CATEGORY_KEYS.has(key)) add(`${p}/${key}`, 'unknown key')
      checkCommon(p, entry)
      checkFormerNames(`${p}/formerNames`, entry.formerNames)
      const name = entry.name
      if (typeof name !== 'string' || !LOWER_WORD.test(name)) {
        add(`${p}/name`, 'must be one lowercase word')
        return
      }
      claim(`${p}/name`, name, 'category')
      const form = entry.form
      if (typeof form !== 'string' || !form.startsWith(`${name}:`) || form.length <= name.length + 1) {
        add(`${p}/form`, `must start with "${name}:" and name what follows the colon`)
      }
    })
  }

  // A diagnostic could not tell a former name from a current one
  for (const [name, pointer] of former) {
    const lower = name.toLowerCase()
    if (current.has(`action:${lower}`) || current.has(`category:${lower}`)) {
      add(pointer, `"${name}" is a current name`)
    }
  }

  // ADR-0002's budget, phase 2 included
  if (Array.isArray(actions) && actions.length > BUDGET.actions) {
    add('/actions', `${actions.length} actions, phase 2 included, exceed ADR-0002's budget of ` +
      `${BUDGET.actions}: merge actions into one verb with operations, or raise the budget with an ADR`)
  }
  if (Array.isArray(categories) && categories.length > BUDGET.eventCategories) {
    add('/eventCategories', `${categories.length} event categories, phase 2 included, exceed ` +
      `ADR-0002's budget of ${BUDGET.eventCategories}: raise the budget with an ADR`)
  }
  return problems
}

/**
 * Why an example is not an action object of this name (ADR-0005 F5): one key, the action's name;
 * for a merged action, the value is an operation name or an object with exactly one operation key.
 */
function exampleProblem(name: string, operations: string[] | undefined, example: unknown) {
  if (!isObject(example) || Object.keys(example).length !== 1 || !(name in example)) {
    return `must be an object with the single key "${name}"`
  }
  if (!operations) return null
  const value = example[name]
  if (typeof value === 'string') {
    return operations.includes(value) ? null : `"${value}" is not an operation`
  }
  if (isObject(value) && Object.keys(value).filter(k => operations.includes(k)).length === 1) return null
  return 'must give exactly one operation, as a string or as the one operation key of an object'
}

/**
 * Why `action` is not an action of format 1.0 as ADR-0005 F5 writes it, or null if it is one.
 * Checks the name and, for a merged action, the operation; the arguments are the schema's.
 */
export function actionFormProblem(v: Vocabulary, action: unknown): string | null {
  if (!isObject(action) || Object.keys(action).length !== 1) return 'an action is an object with one key'
  const name = Object.keys(action)[0]!
  const entry = v.actions.find(a => a.name === name)
  if (!entry) {
    const replacement = formerNames(v.actions).find(([f]) => f === name)
    return `unknown action "${name}"` + (replacement ? ` (now "${replacement[1]}")` : '')
  }
  if (entry.phase !== 1) return `"${name}" is reserved for a later version`
  return exampleProblem(name, entry.operations, action)
}

/** The vocabulary, or an error that lists every problem checkVocabulary() finds. */
export function readVocabulary(value: unknown): Vocabulary {
  const problems = checkVocabulary(value)
  if (problems.length) {
    throw new Error(`the vocabulary has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`)
  }
  return value as Vocabulary
}

const names = (list: { name: string, phase: Phase }[], phase?: Phase) =>
  list.filter(e => phase === undefined || e.phase === phase).map(e => e.name)

/** [former name, current name] pairs, in file order. */
const formerNames = (list: { name: string, formerNames?: string[] }[]) =>
  list.flatMap(e => (e.formerNames ?? []).map((f): [string, string] => [f, e.name]))

/** `^(?:enter|exit|timer):<identifier>$` for the categories given. */
const eventPattern = (v: Vocabulary, categories: string[]) =>
  `^(?:${categories.join('|')}):${patternBody(v.identifier)}$`

/** Text of every generated file, keyed by its path relative to the repository root. */
export function renderOutputs(value: unknown): Map<string, string> {
  const v = readVocabulary(value)
  return new Map([
    [OUTPUT_PATHS.schema, renderSchema(v)],
    [OUTPUT_PATHS.typescript, renderTypeScript(v)],
    [OUTPUT_PATHS.python, renderPython(v)]
  ])
}

function renderSchema(v: Vocabulary): string {
  const defs: Record<string, unknown> = {
    identifier: {
      description: 'Every name an author chooses (ADR-0005 F4).',
      type: 'string',
      pattern: v.identifier
    },
    action: {
      description: 'Actions an experiment file of format 1.0 may use.',
      enum: names(v.actions, 1)
    }
  }
  const reservedActions = names(v.actions, 2)
  if (reservedActions.length) {
    defs.reservedAction = {
      description: 'Actions reserved for later versions: rejected with an "available in phase 2" diagnostic.',
      enum: reservedActions
    }
  }
  for (const a of v.actions) {
    if (!a.operations) continue
    defs[`${a.name}Operation`] = {
      description: `Operations of the merged action ${a.name}.`,
      enum: a.operations
    }
  }
  defs.event = {
    description: 'A task event of format 1.0: <category>:<id>.',
    type: 'string',
    pattern: eventPattern(v, names(v.eventCategories, 1))
  }
  const reservedCategories = names(v.eventCategories, 2)
  if (reservedCategories.length) {
    defs.reservedEvent = {
      description: 'A task event of a category reserved for later versions.',
      type: 'string',
      pattern: `^(?:${reservedCategories.join('|')}):`
    }
  }
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $comment: `${GENERATED_BY}; do not edit. The experiment schema refers to these definitions.`,
    $defs: defs
  }
  return `${JSON.stringify(schema, null, 2)}\n`
}

// String literals: single-quoted in TypeScript, as the repository writes it; double-quoted in
// Python, where JSON's escaping is valid (the generated Python uses no raw strings)
const ts = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const py = (s: string) => JSON.stringify(s)

/** `head[a, b] tail` on one line, or one item per line when that line would pass 100 columns. */
function wrapped(head: string, items: string[], tail: string, indent: string, open = '[', close = ']') {
  const line = `${head}${open}${items.join(', ')}${close}${tail}`
  if (line.length <= 100) return [line]
  return [`${head}${open}`, ...items.map(item => `${indent}${item},`), `${close}${tail}`]
}

const tsConst = (name: string, list: string[]) =>
  wrapped(`export const ${name} = `, list.map(ts), ' as const', '  ')

const pyConst = (name: string, list: string[]) => list.length === 1
  ? [`${name} = (${py(list[0]!)},)`]
  : wrapped(`${name} = `, list.map(py), '', '    ', '(', ')')

function renderTypeScript(v: Vocabulary): string {
  return [
    `// ${GENERATED_BY}.`,
    '// Do not edit: change the vocabulary file and regenerate. ADR-0005 F5 decides the names.',
    '// ADR-0002 keeps the format within 12 actions and 6 event categories; phase 2 extends the',
    '// same format, so its reserved names count too.',
    '',
    '/** Pattern of every name an author chooses (ADR-0005 F4). */',
    `export const IDENTIFIER_PATTERN = ${ts(v.identifier)}`,
    '',
    '/** Every declarative action, phase 2 included, with its Python name and phase. */',
    'export const ACTIONS = {',
    ...v.actions.map(a => `  ${a.name}: { python: ${ts(pythonName(a.name))}, phase: ${a.phase} },`),
    '} as const',
    'export type ActionName = keyof typeof ACTIONS',
    '',
    '/** Actions an experiment file of format 1.0 may use. */',
    ...tsConst('PHASE1_ACTIONS', names(v.actions, 1)),
    'export type Phase1ActionName = (typeof PHASE1_ACTIONS)[number]',
    '',
    '/** Actions reserved for later versions (an "available in phase 2" diagnostic). */',
    ...tsConst('RESERVED_ACTIONS', names(v.actions, 2)),
    '',
    '/** Operations of the merged actions (ADR-0005 F5). */',
    'export const ACTION_OPERATIONS = {',
    ...v.actions.flatMap(a => a.operations ? [`  ${a.name}: [${a.operations.map(ts).join(', ')}],`] : []),
    '} as const',
    '',
    '/** Task-event categories, phase 2 included; an event is `<category>:<name>`. */',
    ...tsConst('EVENT_CATEGORIES', names(v.eventCategories)),
    'export type EventCategory = (typeof EVENT_CATEGORIES)[number]',
    '',
    '/** Task-event categories of format 1.0. */',
    ...tsConst('PHASE1_EVENT_CATEGORIES', names(v.eventCategories, 1)),
    '',
    '/** Task-event categories reserved for later versions. */',
    ...tsConst('RESERVED_EVENT_CATEGORIES', names(v.eventCategories, 2)),
    '',
    '/** Pattern of a task event of format 1.0. */',
    `export const PHASE1_EVENT_PATTERN = ${ts(eventPattern(v, names(v.eventCategories, 1)))}`,
    '',
    '/** Earlier action names (v0.3, designs, prototypes) and their replacements, for did-you-mean. */',
    'export const FORMER_ACTION_NAMES = {',
    ...formerNames(v.actions).map(([f, c]) => `  ${f}: ${ts(c)},`),
    '} as const',
    '',
    '/** Earlier event names and the categories that replace them, for did-you-mean. */',
    'export const FORMER_EVENT_NAMES = {',
    ...formerNames(v.eventCategories).map(([f, c]) => `  ${f}: ${ts(c)},`),
    '} as const',
    ''
  ].join('\n')
}

function renderPython(v: Vocabulary): string {
  return [
    '"""Names of the declarative task vocabulary (ADR-0005 F5).',
    '',
    `${GENERATED_BY}.`,
    'Do not edit: change the vocabulary file and regenerate. ADR-0002 keeps the format within 12',
    'actions and 6 event categories; phase 2 extends the same format, so its reserved names count too.',
    'JSON uses the camelCase action names and Python the snake_case ones (ACTIONS maps one to the',
    'other); event categories and operations are the same in both.',
    '"""',
    'import re',
    '',
    '#: Every name an author chooses (ADR-0005 F4). Match it with IDENTIFIER.fullmatch(name): in Python',
    '#: `$` also matches before a final newline, in ECMAScript (JSON Schema patterns) it does not.',
    `IDENTIFIER = re.compile(${py(patternBody(v.identifier))})`,
    '',
    '#: Every declarative action, phase 2 included: JSON name -> Python name',
    'ACTIONS = {',
    ...v.actions.map(a => `    ${py(a.name)}: ${py(pythonName(a.name))},`),
    '}',
    '',
    '#: Actions an experiment file of format 1.0 may use (JSON names)',
    ...pyConst('PHASE1_ACTIONS', names(v.actions, 1)),
    '',
    '#: Actions reserved for later versions (JSON names)',
    ...pyConst('RESERVED_ACTIONS', names(v.actions, 2)),
    '',
    '#: Operations of the merged actions',
    'ACTION_OPERATIONS = {',
    ...v.actions.flatMap(a => a.operations ? [`    ${py(a.name)}: (${a.operations.map(py).join(', ')}),`] : []),
    '}',
    '',
    '#: Task-event categories, phase 2 included; an event is "<category>:<name>"',
    ...pyConst('EVENT_CATEGORIES', names(v.eventCategories)),
    '',
    '#: Task-event categories of format 1.0',
    ...pyConst('PHASE1_EVENT_CATEGORIES', names(v.eventCategories, 1)),
    '',
    '#: Task-event categories reserved for later versions',
    ...pyConst('RESERVED_EVENT_CATEGORIES', names(v.eventCategories, 2)),
    '',
    '#: Earlier action names (v0.3, designs, prototypes) -> the action that replaces each',
    'FORMER_ACTION_NAMES = {',
    ...formerNames(v.actions).map(([f, c]) => `    ${py(f)}: ${py(c)},`),
    '}',
    '',
    '#: Earlier event names -> the category that replaces each',
    'FORMER_EVENT_NAMES = {',
    ...formerNames(v.eventCategories).map(([f, c]) => `    ${py(f)}: ${py(c)},`),
    '}',
    ''
  ].join('\n')
}
