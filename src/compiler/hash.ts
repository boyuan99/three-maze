// Canonical JSON and SHA-256 for the scene compiler's hashes: the collider manifest's (ADR-0001
// R5.5, plan item MOT-08) and, later, the source and IR hashes of compileScene (TS-04). Plain
// TypeScript that needs nothing from Node or the DOM but TextEncoder, so the same code gives the
// same hash in Node, in a worker and in the renderer: Web Crypto's digest is asynchronous and
// missing outside secure contexts, and node:crypto exists only in Node.

/**
 * The JSON Canonicalization Scheme (RFC 8785) of a JSON value: no whitespace, object keys sorted
 * by their UTF-16 code units, numbers and strings serialised as ECMAScript's JSON.stringify does
 * (-0 as 0). Object properties whose value is undefined are left out, as JSON.stringify does;
 * any other value that JSON cannot hold (undefined in an array, NaN, Infinity, a function, a
 * class instance such as Map or Date) throws a TypeError that names its path.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$')
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} is not a JSON number`)
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(',')}]`
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${path}: only plain objects and arrays are JSON`)
      }
      const record = value as Record<string, unknown>
      // Array.prototype.sort compares strings by UTF-16 code units, as RFC 8785 sorts keys
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
      const members = keys.map((key) =>
        `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`)
      return `{${members.join(',')}}`
    }
    default:
      throw new TypeError(`${path}: ${typeof value} is not a JSON type`)
  }
}

// SHA-256 (FIPS 180-4): round constants and initial hash value
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** SHA-256 digest (32 bytes) of `bytes`. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const n = bytes.length
  // The message, a 1 bit, zeros, and its length in bits as a 64-bit big-endian number
  const padded = new Uint8Array(Math.ceil((n + 9) / 64) * 64)
  padded.set(bytes)
  padded[n] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(n / 0x2000_0000))
  view.setUint32(padded.length - 4, (n << 3) >>> 0)
  // Sums are exact in double precision and taken modulo 2^32 by >>> 0 or by the Uint32Arrays
  const state = Uint32Array.from(INITIAL)
  const w = new Uint32Array(64)
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + 4 * t)
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = w[t - 16] + s0 + w[t - 7] + s1
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let t = 0; t < 64; t++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const choice = (e & f) ^ (~e & g)
      const t1 = (h + sum1 + choice + K[t] + w[t]) >>> 0
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    state[0] += a
    state[1] += b
    state[2] += c
    state[3] += d
    state[4] += e
    state[5] += f
    state[6] += g
    state[7] += h
  }
  const digest = new Uint8Array(32)
  const out = new DataView(digest.buffer)
  state.forEach((word, i) => out.setUint32(4 * i, word))
  return digest
}

/** SHA-256 of the UTF-8 encoding of `text`, as 64 lower-case hexadecimal digits. */
export function sha256Hex(text: string): string {
  let hex = ''
  for (const byte of sha256(new TextEncoder().encode(text))) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** SHA-256 of a JSON value's canonical form (canonicalJson), as 64 hexadecimal digits. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
