// @ts-check
// Validator for the link protocol v1 (protocol/v1/SPEC.md): checks a message against the JSON
// Schemas in protocol/v1 with Ajv 8 (draft 2020-12). Plain JavaScript, so that Node runs it
// without a TypeScript step (an end-to-end harness, a log checker); `// @ts-check` makes
// `npm run typecheck` check it through the tests that import it.
//
// threemaze/link/validate.py is its Python twin. Both report the same problems in the same form
// ({path, keyword, message}, sorted by path and keyword) and accept and reject the same messages:
// the tests in test/frontend/protocol and test/backend run both on protocol/v1/examples.
//
// Senders validate strictly. A receiver may pass {tolerant: true}, which ignores properties the
// schemas do not know, as a newer minor version may add them (SPEC.md section 4.4).
import Ajv2020 from 'ajv/dist/2020.js'
import ack from '../../protocol/v1/ack.schema.json' with { type: 'json' }
import common from '../../protocol/v1/common.schema.json' with { type: 'json' }
import error from '../../protocol/v1/error.schema.json' with { type: 'json' }
import event from '../../protocol/v1/event.schema.json' with { type: 'json' }
import heartbeat from '../../protocol/v1/heartbeat.schema.json' with { type: 'json' }
import hello from '../../protocol/v1/hello.schema.json' with { type: 'json' }
import message from '../../protocol/v1/message.schema.json' with { type: 'json' }
import poseBatch from '../../protocol/v1/pose.batch.schema.json' with { type: 'json' }
import renderReport from '../../protocol/v1/render.report.schema.json' with { type: 'json' }
import sampleBatch from '../../protocol/v1/sample.batch.schema.json' with { type: 'json' }
import sessionState from '../../protocol/v1/session.state.schema.json' with { type: 'json' }
import welcome from '../../protocol/v1/welcome.schema.json' with { type: 'json' }

/** @typedef {import('./linkTypes.ts').LinkMessage} LinkMessage */

/**
 * One problem in a message.
 * @typedef {object} LinkIssue
 * @property {string} path JSON Pointer to the offending value; '' for the message itself
 * @property {string} keyword the JSON Schema keyword that failed, or 'json' for text that is not
 *   JSON
 * @property {string} message
 */

/** Every schema file of protocol/v1; message.schema.json validates a whole message. */
export const LINK_SCHEMAS = Object.freeze([
  common, message, hello, welcome, heartbeat, ack, error, sessionState, sampleBatch,
  poseBatch, event, renderReport
])

/** The message types of version 1, in the order of message.schema.json. */
export const LINK_MESSAGE_TYPES = Object.freeze([...message.properties.type.enum])

/** Heartbeat interval and watchdog limit in ms, as welcome announces them (SPEC.md section 6). */
export const HEARTBEAT_MS = welcome.$defs.data.properties.heartbeat_ms.const
export const WATCHDOG_MS = welcome.$defs.data.properties.watchdog_ms.const

/**
 * A copy of a schema without its `additionalProperties: false` and
 * `unevaluatedProperties: false`, for tolerant receivers.
 * @param {unknown} node
 * @returns {unknown}
 */
function relax(node) {
  if (Array.isArray(node)) return node.map(relax)
  if (node === null || typeof node !== 'object') return node
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if ((key === 'additionalProperties' || key === 'unevaluatedProperties') && value === false) {
      continue
    }
    out[key] = relax(value)
  }
  return out
}

/** @type {Map<boolean, import('ajv').ValidateFunction>} */
const compiled = new Map()

/** @param {boolean} tolerant */
function validatorFor(tolerant) {
  let validate = compiled.get(tolerant)
  if (!validate) {
    // strict: Ajv refuses schemas with unknown keywords, ambiguous types or loose tuples.
    // strictRequired is off because an if/then branch may require a property that its parent
    // defines (hello's session); the schema tests check every required name instead.
    // strictNumbers: NaN and Infinity fail every number and integer check.
    const ajv = new Ajv2020({
      strict: true, strictRequired: false, strictNumbers: true, allErrors: true
    })
    for (const schema of LINK_SCHEMAS) {
      const source = tolerant ? relax(schema) : schema
      ajv.addSchema(/** @type {import('ajv').AnySchemaObject} */ (source))
    }
    validate = /** @type {import('ajv').ValidateFunction} */ (ajv.getSchema(message.$id))
    compiled.set(tolerant, validate)
  }
  return validate
}

/**
 * Non-finite numbers anywhere in a value (JSON has none, but an object built in code can).
 * @param {unknown} value
 * @param {string} path
 * @param {LinkIssue[]} out
 */
function nonFinite(value, path, out) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      out.push({ path, keyword: 'type', message: 'must be a finite number' })
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => nonFinite(item, `${path}/${i}`, out))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      nonFinite(item, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, out)
    }
  }
}

/**
 * Ajv's errors in the shared form: wrapper errors that the Python validator does not report
 * (`if`, `propertyNames`, and the branch errors under a failed `anyOf`) are left out.
 * @param {import('ajv').ErrorObject[]} errors
 * @returns {LinkIssue[]}
 */
function fromAjv(errors) {
  const anyOfPaths = new Set(errors.filter((e) => e.keyword === 'anyOf').map((e) => e.instancePath))
  /** @type {LinkIssue[]} */
  const out = []
  for (const e of errors) {
    if (e.keyword === 'if' || e.keyword === 'propertyNames') continue
    if (e.keyword !== 'anyOf' && anyOfPaths.has(e.instancePath)) continue
    let text = e.message ?? e.keyword
    if (e.keyword === 'additionalProperties') text += ` (${e.params.additionalProperty})`
    if (e.keyword === 'unevaluatedProperties') text += ` (${e.params.unevaluatedProperty})`
    out.push({ path: e.instancePath, keyword: e.keyword, message: text })
  }
  return out
}

/**
 * One issue per path and keyword, sorted by path and keyword (code-unit order, as Python sorts).
 * @param {LinkIssue[]} issues
 * @returns {LinkIssue[]}
 */
function tidy(issues) {
  /** @type {Map<string, LinkIssue>} */
  const seen = new Map()
  for (const issue of issues) {
    const key = `${issue.path}\u0000${issue.keyword}`
    if (!seen.has(key)) seen.set(key, issue)
  }
  const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0)
  return [...seen.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.keyword, b.keyword))
}

/**
 * The problems that make `value` an invalid link message; empty if it is valid.
 * @param {unknown} value a parsed message
 * @param {{tolerant?: boolean}} [options] tolerant: ignore properties the schemas do not know
 * @returns {LinkIssue[]}
 */
export function linkErrors(value, { tolerant = false } = {}) {
  const validate = validatorFor(tolerant)
  /** @type {LinkIssue[]} */
  const issues = []
  nonFinite(value, '', issues)
  if (!validate(value)) issues.push(...fromAjv(validate.errors ?? []))
  return tidy(issues)
}

/**
 * True if `value` is a valid link message (strict).
 * @param {unknown} value
 * @returns {value is LinkMessage}
 */
export function isLinkMessage(value) {
  return linkErrors(value).length === 0
}

/**
 * Parses one message from the text of a WebSocket frame and validates it.
 * @param {string} text
 * @param {{tolerant?: boolean}} [options]
 * @returns {{message: LinkMessage, errors: []} | {message: null, errors: LinkIssue[]}}
 */
export function parseLinkMessage(text, options) {
  /** @type {unknown} */
  let value
  try {
    value = JSON.parse(text)
  } catch (err) {
    const issue = { path: '', keyword: 'json', message: `not JSON: ${String(err)}` }
    return { message: null, errors: [issue] }
  }
  const errors = linkErrors(value, options)
  if (errors.length) return { message: null, errors }
  return { message: /** @type {LinkMessage} */ (value), errors: [] }
}
