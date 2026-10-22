// Link protocol v1 (protocol/v1/SPEC.md), JavaScript side: src/protocol/validate.js accepts every
// example in protocol/v1/examples and reports exactly the problems that
// protocol/v1/examples/expected-errors.json lists for each malformed one. The Python validator is
// held to the same file (test/backend/test_link_protocol.py), so both report the same problems.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HEARTBEAT_MS,
  isLinkMessage,
  LINK_MESSAGE_TYPES,
  LINK_SCHEMAS,
  linkErrors,
  parseLinkMessage,
  WATCHDOG_MS
} from '../../../src/protocol/validate.js'
import type { LinkIssue } from '../../../src/protocol/validate.js'

const PROTOCOL = fileURLToPath(new URL('../../../protocol/v1/', import.meta.url))
const EXAMPLES = join(PROTOCOL, 'examples')

interface ExpectedCase {
  why: string
  issues: { path: string; keyword: string }[]
}
const EXPECTED: Record<string, ExpectedCase> = JSON.parse(
  readFileSync(join(EXAMPLES, 'expected-errors.json'), 'utf8')
).cases

const files = (dir: string, ext: string) =>
  readdirSync(join(EXAMPLES, dir)).filter((name) => name.endsWith(ext)).sort()
const valid = files('.', '.json').filter((name) => name !== 'expected-errors.json')
const read = (rel: string) => readFileSync(join(EXAMPLES, rel), 'utf8')
const pairs = (issues: LinkIssue[]) => issues.map(({ path, keyword }) => ({ path, keyword }))

describe('valid examples', () => {
  it.each(valid)('%s is valid and its file name starts with its type', (name) => {
    const text = read(name)
    const message = JSON.parse(text)
    expect(linkErrors(message)).toEqual([])
    expect(isLinkMessage(message)).toBe(true)
    expect(parseLinkMessage(text)).toEqual({ message, errors: [] })
    expect(name.replace(/\.json$/, '').split('--')[0]).toBe(message.type)
  })

  it('cover every message type, event kind and render report kind', () => {
    const messages = valid.map((name) => JSON.parse(read(name)))
    expect(new Set(messages.map((m) => m.type))).toEqual(new Set(LINK_MESSAGE_TYPES))
    const kinds = (type: string) =>
      new Set(messages.filter((m) => m.type === type).map((m) => m.data.kind))
    const schema = (id: string) => LINK_SCHEMAS.find((s) => s.$id.endsWith(id)) as any
    expect(kinds('event')).toEqual(
      new Set(schema('/event.schema.json').$defs.data.properties.kind.enum))
    expect(kinds('render.report')).toEqual(
      new Set(schema('/render.report.schema.json').$defs.data.properties.kind.enum))
  })

  it('carry no file path and no .py name in any string', () => {
    const strings: [string, string][] = []
    const walk = (value: unknown, key: string) => {
      if (typeof value === 'string') strings.push([key, value])
      else if (Array.isArray(value)) value.forEach((item) => walk(item, key))
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          strings.push([k, k])
          walk(v, k)
        }
      }
    }
    for (const name of valid) walk(JSON.parse(read(name)), '')
    expect(strings.length).toBeGreaterThan(100)
    for (const [key, value] of strings) {
      expect(value, key).not.toMatch(/\\|[A-Za-z]:[\\/]|\/\/|\.py[cdow]?\b/i)
      // only a JSON Pointer (error data.path) and the protocol name hold a slash
      if (value.includes('/')) {
        expect(key === 'path' || value === 'three-maze/link', `${key}: ${value}`).toBe(true)
      }
    }
  })
})

describe('malformed examples', () => {
  const cases = [
    ...files('invalid', '.json').map((name) => `invalid/${name}`),
    ...files('invalid-text', '.txt').map((name) => `invalid-text/${name}`)
  ]

  it('are each listed in expected-errors.json, and every listed case exists', () => {
    expect(cases.sort()).toEqual(Object.keys(EXPECTED).sort())
    expect(cases.length).toBeGreaterThanOrEqual(50)
  })

  it.each(cases)('%s is rejected with exactly the listed problems', (rel) => {
    const text = read(rel)
    const result = parseLinkMessage(text)
    expect(result.message).toBeNull()
    expect(pairs(result.errors)).toEqual(EXPECTED[rel].issues)
    if (rel.startsWith('invalid/')) {
      expect(isLinkMessage(JSON.parse(text))).toBe(false)
      expect(pairs(linkErrors(JSON.parse(text)))).toEqual(EXPECTED[rel].issues)
    }
  })
})

describe('numbers that JSON cannot carry', () => {
  const heartbeat = (n: unknown) => ({ type: 'heartbeat', t: 5, data: { n } })

  it('are rejected where an object built in code holds them', () => {
    expect(linkErrors(heartbeat(Number.NaN))).toEqual([
      { path: '/data/n', keyword: 'type', message: 'must be a finite number' }
    ])
    expect(pairs(linkErrors(heartbeat(Number.POSITIVE_INFINITY)))).toEqual([
      { path: '/data/n', keyword: 'type' }
    ])
    const pose = JSON.parse(read('pose.batch.json'))
    pose.data.poses[1].yaw = Number.NEGATIVE_INFINITY
    expect(pairs(linkErrors(pose))).toEqual([{ path: '/data/poses/1/yaw', keyword: 'type' }])
  })

  it('include integers beyond 2^53 - 1 and fractions where whole microseconds are due', () => {
    expect(pairs(linkErrors(heartbeat(2 ** 53)))).toEqual([{ path: '/data/n', keyword: 'maximum' }])
    expect(pairs(linkErrors(heartbeat(1.5)))).toEqual([{ path: '/data/n', keyword: 'type' }])
    expect(linkErrors(heartbeat(2 ** 53 - 1))).toEqual([])
  })

  it('include integers too large for a double, which JSON.parse reads as Infinity', () => {
    // the Python validator must give the same answer (test_link_protocol.py)
    for (const digits of ['1' + '0'.repeat(400), '1'.repeat(5000), '-' + '1'.repeat(5000)]) {
      const text = `{"type": "heartbeat", "t": 5, "data": {"n": ${digits}}}`
      expect(pairs(parseLinkMessage(text).errors)).toEqual([{ path: '/data/n', keyword: 'type' }])
    }
  })
})

describe('text', () => {
  const error = (message: string) => ({ type: 'error', t: 5, data: { code: 'internal', message } })

  it('is one line: no control character and no line or paragraph separator', () => {
    for (const c of ['\n', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029']) {
      expect(pairs(linkErrors(error(`a${c}b`))), JSON.stringify(c)).toEqual([
        { path: '/data/message', keyword: 'pattern' }
      ])
    }
    expect(linkErrors(error('a\u00a0b, (c) 1.5 \u00b5s'))).toEqual([])
  })
})

describe('tolerant receivers', () => {
  const newer = () => {
    const message = JSON.parse(read('event--zone-enter.json'))
    message.hint = 'from 1.1'
    message.data.speed_cm_s = 12.5
    return message
  }

  it('ignore properties a newer minor version may add, at any depth', () => {
    expect(pairs(linkErrors(newer()))).toEqual([
      { path: '', keyword: 'additionalProperties' },
      { path: '/data', keyword: 'unevaluatedProperties' }
    ])
    expect(linkErrors(newer(), { tolerant: true })).toEqual([])
    const sample = JSON.parse(read('sample.batch--v1-device.json'))
    sample.data.samples[0].t_host_us = 512340377
    expect(linkErrors(sample, { tolerant: true })).toEqual([])
    expect(parseLinkMessage(JSON.stringify(newer()), { tolerant: true }).errors).toEqual([])
  })

  it('still reject what the schemas forbid', () => {
    const message = newer()
    delete message.data.edge
    message.data.epoch = -1
    expect(pairs(linkErrors(message, { tolerant: true }))).toEqual([
      { path: '/data', keyword: 'required' },
      { path: '/data/epoch', keyword: 'minimum' }
    ])
  })
})

describe('protocol constants', () => {
  it('heartbeat every 20 ms, at least five per 100 ms watchdog window (SPEC.md section 6)', () => {
    expect(HEARTBEAT_MS).toBe(20)
    expect(WATCHDOG_MS).toBe(100)
    expect(WATCHDOG_MS / HEARTBEAT_MS).toBeGreaterThanOrEqual(5)
  })

  it('keep the core message types within the budget of 12, with DPR-05b to come', () => {
    expect(LINK_MESSAGE_TYPES).toHaveLength(10)
    expect(LINK_MESSAGE_TYPES.length + 2).toBeLessThanOrEqual(12)
  })

  it('give every message type its own schema file', () => {
    const ids = LINK_SCHEMAS.map((s) => s.$id.split('/').pop())
    for (const type of LINK_MESSAGE_TYPES) expect(ids).toContain(`${type}.schema.json`)
    expect(readdirSync(PROTOCOL).filter((n) => n.endsWith('.schema.json')).sort())
      .toEqual([...ids].sort())
  })
})
