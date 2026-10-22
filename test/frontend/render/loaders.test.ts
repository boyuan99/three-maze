// The render host's DOM-free loaders (src/render/loaders.ts). Node has no createImageBitmap, so the
// colour-texture tests stand in for it and for fetch and check what ImageBitmapLoader asks of them;
// the sky is a real EXR from public/, decoded by three's EXRLoader.
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createColorTextureLoader, createSkyLoader, IMAGE_BITMAP_OPTIONS } from '../../../src/render/index.ts'
import { fetchFromPublic, servedManager } from '../v0Reference/harness.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function standIns({ decodeFails = false } = {}) {
  const fetched: string[] = []
  const decoded: unknown[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(String(url))
    return { blob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])]) }
  })
  vi.stubGlobal('createImageBitmap', async (_blob: Blob, options: unknown) => {
    decoded.push(structuredClone(options))
    if (decodeFails) throw new Error('The source image could not be decoded.')
    return { width: 64, height: 32, close() {} }
  })
  return { fetched, decoded }
}

describe('colour textures (ImageBitmapLoader)', () => {
  it("decodes with ADR-0003 1c's options, flipped at decode instead of at upload", async () => {
    const { decoded } = standIns()
    const texture = await createColorTextureLoader()('/mazes/Hallway04/assets/Chess_Pattern.jpg')
    // imageOrientation and premultiplyAlpha as given; three adds colorSpaceConversion itself
    expect(decoded).toEqual([{ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }])
    expect(texture).toBeInstanceOf(THREE.Texture)
    expect(texture.image).toMatchObject({ width: 64, height: 32 })
    expect(texture.flipY).toBe(false)
    expect(texture.premultiplyAlpha).toBe(false)
    expect(texture.version).toBe(1) // needsUpdate: uploaded at its first use
    // The shared options object is never written to
    expect(IMAGE_BITMAP_OPTIONS).toEqual({ imageOrientation: 'flipY', premultiplyAlpha: 'none' })
    expect(Object.isFrozen(IMAGE_BITMAP_OPTIONS)).toBe(true)
  })

  it('gives a new texture per call, as v0.3 did, from one fetch and decode per URL', async () => {
    const { fetched, decoded } = standIns()
    const load = createColorTextureLoader()
    const [a, b] = await Promise.all([load('/a.jpg'), load('/a.jpg')])
    const c = await load('/b.jpg')
    expect(a).not.toBe(b)
    expect(a.image).toBe(b.image)
    expect(c.image).not.toBe(a.image)
    expect(fetched).toEqual(['/a.jpg', '/b.jpg'])
    expect(decoded).toHaveLength(2)
  })

  it('rejects a texture that cannot be decoded, naming it, and tries again on the next call', async () => {
    const { fetched } = standIns({ decodeFails: true })
    const load = createColorTextureLoader()
    await expect(load('/mazes/missing.jpg')).rejects.toThrow(/^texture \/mazes\/missing\.jpg could not be loaded: The source image could not be decoded\./)
    await expect(load('/mazes/missing.jpg')).rejects.toThrow(/could not be loaded/)
    expect(fetched).toEqual(['/mazes/missing.jpg', '/mazes/missing.jpg'])
  })
})

describe('sky (EXRLoader)', () => {
  it('decodes the shipped EXR sky without the DOM', async () => {
    vi.stubGlobal('fetch', fetchFromPublic)
    const sky = await createSkyLoader(servedManager)('/mazes/Hallway02/assets/evening_road_01_puresky_1k.exr')
    expect(sky).toBeInstanceOf(THREE.DataTexture)
    expect(sky.image.width).toBe(1024)
    expect(sky.image.height).toBe(512)
    expect(sky.type).toBe(THREE.HalfFloatType)
  })

  it('rejects a sky that cannot be fetched, naming it', async () => {
    vi.stubGlobal('fetch', fetchFromPublic)
    await expect(createSkyLoader(servedManager)('/mazes/Hallway02/assets/missing.exr'))
      .rejects.toThrow(/^sky \/mazes\/Hallway02\/assets\/missing\.exr could not be loaded: /)
  })
})
