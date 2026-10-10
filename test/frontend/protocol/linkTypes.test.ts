// The generated TypeScript types of the link protocol v1 (src/protocol/linkTypes.ts): the file
// matches what scripts/gen-link-types.mjs makes from the schemas today, and the types are precise
// enough to catch the mistakes the schemas catch (`npm run typecheck` checks the @ts-expect-error
// lines below; Vitest runs the rest).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { generateLinkTypes, OUTPUT } from '../../../scripts/gen-link-types.mjs'
import { isLinkMessage, linkErrors } from '../../../src/protocol/validate.js'
import type {
  EventData,
  LinkMessage,
  LinkMessageType,
  MessageOfType,
  RenderReportData
} from '../../../src/protocol/linkTypes.ts'

describe('generated types', () => {
  it('are up to date with the schemas (npm run protocol:types)', () => {
    expect(readFileSync(OUTPUT, 'utf8')).toBe(generateLinkTypes())
  })

  it('describe valid messages, which the validator accepts', () => {
    const messages: LinkMessage[] = [
      {
        type: 'hello', t: 1203411, id: 'h1',
        data: {
          protocol: 'three-maze/link', version: '1.0', role: 'motion',
          client: { impl: 'three-maze-motion-worker', version: '0.3.0' },
          session: '2026-10-23T14-03-11Z_m12', versions: { three: '0.169.0' }
        }
      },
      {
        type: 'event', t: 9310415,
        data: {
          kind: 'zone', seq: 2028, epoch: 3, t_dev_us: 9112000, world: 'hallway',
          zone: 'reward', edge: 'enter', cause: 'move'
        }
      },
      {
        type: 'sample.batch', t: 513340377,
        data: {
          seq_source: 'device',
          samples: [
            { seq: 0, t_dev_us: 1000000, dt_us: 4000, d: [-0.0349, 0.4188, 0.07],
              raw: [12, -1, 35, 3], flags: 0, gap: 0 }
          ]
        }
      },
      {
        type: 'render.report', t: 6201050,
        data: {
          kind: 'clock', time_origin_us: 1792765391123456, phase: 'self_test', pass: true,
          intervals: 299, median_hz: 60, spread_us: 310
        }
      },
      { type: 'session.state', t: 510002231, data: { state: 'idle' } },
      { type: 'ack', t: 9310500, re: 'c-118', data: {} }
    ]
    for (const message of messages) expect(linkErrors(message)).toEqual([])
  })

  it('narrow by type and kind', () => {
    const value: unknown = JSON.parse(
      '{"type":"event","t":7120044,"data":{"kind":"seq_gap","seq":5,"epoch":0,' +
      '"t_dev_us":1020000,"world":"hallway","lost":2}}')
    expect(isLinkMessage(value)).toBe(true)
    if (!isLinkMessage(value) || value.type !== 'event') throw new Error('not an event')
    const data: EventData = value.data
    const lost = data.kind === 'seq_gap' ? data.lost : 0
    expect(lost).toBe(2)
    const type: LinkMessageType = value.type
    const same: MessageOfType<'event'> = value
    expect([type, same.data.world]).toEqual(['event', 'hallway'])
  })

  it('reject at compile time what the schemas reject at run time', () => {
    const client = { impl: 'w', version: '1' }
    const versions = { three: '0.169.0' }
    const device = {
      profile: 'v1', completeness: 'counted', integrity: 'crc8', seq_source: 'device',
      time_source: 'device', period_us: 4000
    } as const
    const stamp = { seq: 1, epoch: 0, t_dev_us: 4000, world: 'w' }
    const sample = { seq: 0, t_dev_us: 0, dt_us: 1, raw: [0], flags: 0, gap: 0 }
    const clock = {
      time_origin_us: 0, phase: 'rolling', pass: true, intervals: 1, median_hz: 60
    } as const
    // @ts-expect-error a motion client must name its session
    const hello: LinkMessage = { type: 'hello', t: 1, id: 'h1', data: {
      protocol: 'three-maze/link', version: '1.0', role: 'motion', client, versions } }
    // @ts-expect-error a motion client learns the world it starts in
    const welcome: LinkMessage = { type: 'welcome', t: 1, re: 'h1', data: {
      protocol: 'three-maze/link', version: '1.0', role: 'motion', client_id: 'm',
      runtime: client, heartbeat_ms: 20, watchdog_ms: 100, epoch: 0, session: 's', device } }
    // @ts-expect-error a zone event says enter or exit
    const zone: EventData = { kind: 'zone', ...stamp, zone: 'z', cause: 'move' }
    const samples: LinkMessage = { type: 'sample.batch', t: 1, data: { seq_source: 'host',
      // @ts-expect-error d is [forward, left, dyaw]
      samples: [{ ...sample, d: [0, 0] }] } }
    // @ts-expect-error the v1 clock check has no gain field
    const report: RenderReportData = { kind: 'clock', ...clock, spread_us: 0, gain: 1 }
    // @ts-expect-error a heartbeat is not a request
    const heartbeat: LinkMessage = { type: 'heartbeat', t: 1, id: 'x', data: { n: 0 } }
    const rejected: unknown[] = [
      hello, welcome, { type: 'event', t: 1, data: zone }, samples,
      { type: 'render.report', t: 1, data: report }, heartbeat
    ]
    for (const message of rejected) expect(linkErrors(message)).not.toEqual([])
  })
})
