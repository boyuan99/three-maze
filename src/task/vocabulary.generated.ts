// Generated from schema/vocabulary.json by `npm run vocabulary` (tools/vocabulary/generate.ts).
// Do not edit: change the vocabulary file and regenerate. ADR-0005 F5 decides the names.
// ADR-0002 keeps the format within 12 actions and 6 event categories; phase 2 extends the
// same format, so its reserved names count too.

/** Pattern of every name an author chooses (ADR-0005 F4). */
export const IDENTIFIER_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$'

/** Every declarative action, phase 2 included, with its Python name and phase. */
export const ACTIONS = {
  reward: { python: 'reward', phase: 1 },
  teleport: { python: 'teleport', phase: 1 },
  freeze: { python: 'freeze', phase: 1 },
  display: { python: 'display', phase: 1 },
  timer: { python: 'timer', phase: 1 },
  trial: { python: 'trial', phase: 1 },
  set: { python: 'set', phase: 1 },
  endSession: { python: 'end_session', phase: 1 },
  setGain: { python: 'set_gain', phase: 2 },
  setCue: { python: 'set_cue', phase: 2 },
  emit: { python: 'emit', phase: 2 },
  switchWorld: { python: 'switch_world', phase: 2 },
} as const
export type ActionName = keyof typeof ACTIONS

/** Actions an experiment file of format 1.0 may use. */
export const PHASE1_ACTIONS = [
  'reward',
  'teleport',
  'freeze',
  'display',
  'timer',
  'trial',
  'set',
  'endSession',
] as const
export type Phase1ActionName = (typeof PHASE1_ACTIONS)[number]

/** Actions reserved for later versions (an "available in phase 2" diagnostic). */
export const RESERVED_ACTIONS = ['setGain', 'setCue', 'emit', 'switchWorld'] as const

/** Operations of the merged actions (ADR-0005 F5). */
export const ACTION_OPERATIONS = {
  display: ['blank', 'on'],
  timer: ['start', 'cancel'],
  trial: ['start', 'end'],
} as const

/** Task-event categories, phase 2 included; an event is `<category>:<name>`. */
export const EVENT_CATEGORIES = ['enter', 'exit', 'timer', 'input', 'message', 'world'] as const
export type EventCategory = (typeof EVENT_CATEGORIES)[number]

/** Task-event categories of format 1.0. */
export const PHASE1_EVENT_CATEGORIES = ['enter', 'exit', 'timer'] as const

/** Task-event categories reserved for later versions. */
export const RESERVED_EVENT_CATEGORIES = ['input', 'message', 'world'] as const

/** Pattern of a task event of format 1.0. */
export const PHASE1_EVENT_PATTERN = '^(?:enter|exit|timer):[A-Za-z][A-Za-z0-9_]*$'

/** Earlier action names (v0.3, designs, prototypes) and their replacements, for did-you-mean. */
export const FORMER_ACTION_NAMES = {
  water: 'reward',
  deliverWater: 'reward',
  lock_motion: 'freeze',
  blackout: 'display',
  startTimer: 'timer',
  cancelTimer: 'timer',
  set_timer: 'timer',
  cancel_timer: 'timer',
  startTrial: 'trial',
  endTrial: 'trial',
  start_trial: 'trial',
  end_trial: 'trial',
} as const

/** Earlier event names and the categories that replace them, for did-you-mean. */
export const FORMER_EVENT_NAMES = {
  zone_enter: 'enter',
  zone_exit: 'exit',
} as const
