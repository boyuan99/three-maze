// Canonical JSON (RFC 8785) and SHA-256 of the scene compiler (src/compiler/hash.ts), which the
// collider manifest's hash is made of (plan item MOT-08).
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson, hashJson, sha256, sha256Hex } from '../../../src/compiler/hash.ts'

const nodeSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('sha256', () => {
  it('gives the FIPS 180-4 example digests', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  it("equals Node's for every length up to five blocks and for long inputs", () => {
    let state = 12345
    const bytes = (n: number) => Uint8Array.from({ length: n }, () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0
      return state >>> 24
    })
    for (let n = 0; n <= 320; n++) {
      const input = bytes(n)
      expect(hex(sha256(input)), `length ${n}`).toBe(nodeSha256(input))
    }
    for (const n of [4096, 65_537, 1_000_003]) {
      const input = bytes(n)
      expect(hex(sha256(input)), `length ${n}`).toBe(nodeSha256(input))
    }
  })

  it('hashes text as UTF-8', () => {
    const text = 'zone é 中 \u{1F600}'
    expect(sha256Hex(text)).toBe(nodeSha256(Buffer.from(text, 'utf8')))
  })
})

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units at every level, with no whitespace', () => {
    // the property-sorting example of RFC 8785 section 3.2.3
    const value = {
      '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh',
      1: 'One', '\u{1F600}': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis',
    }
    expect(canonicalJson(value)).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control",'
      + '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",'
      + '"\u{1F600}":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}')
    expect(canonicalJson({ b: [3, { y: 1, x: 2 }], a: null })).toBe('{"a":null,"b":[3,{"x":2,"y":1}]}')
  })

  it('writes numbers and strings as ECMAScript does', () => {
    // values from RFC 8785 appendix B
    expect(canonicalJson([0, -0, 1e21, 1e-7, 0.000001, 333333333.33333329, 4.5, 2 ** -1074]))
      .toBe('[0,0,1e+21,1e-7,0.000001,333333333.3333333,4.5,5e-324]')
    expect(canonicalJson('\u0000\b"\\\u001f\u007f/é')).toBe('"\\u0000\\b\\"\\\\\\u001f\u007f/é"')
    expect(canonicalJson(true)).toBe('true')
  })

  it('leaves out properties whose value is undefined, and rejects what JSON cannot hold', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(() => canonicalJson({ a: [1, undefined] }))
      .toThrow(/^\$\.a\[1\]: undefined is not a JSON type/)
    expect(() => canonicalJson({ x: NaN })).toThrow(/^\$\.x: NaN is not a JSON number/)
    expect(() => canonicalJson([Infinity])).toThrow(/is not a JSON number/)
    expect(() => canonicalJson({ m: new Map() })).toThrow(/^\$\.m: only plain objects and arrays/)
    expect(() => canonicalJson(new Date(0))).toThrow(/only plain objects/)
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function is not a JSON type/)
    expect(() => canonicalJson(1n)).toThrow(/bigint is not a JSON type/)
  })

  it('makes hashJson independent of key order and whitespace', () => {
    expect(hashJson(JSON.parse('{ "b": 1, "a": [1, 2] }'))).toBe(hashJson({ a: [1, 2], b: 1 }))
    expect(hashJson({ a: [1, 2] })).not.toBe(hashJson({ a: [2, 1] }))
    expect(hashJson({ a: 1 })).toBe(sha256Hex('{"a":1}'))
  })
})
