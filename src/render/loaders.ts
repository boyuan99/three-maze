// Asset loaders that work without the DOM, in the scene window and in a worker (ADR-0003 1c).
//
// three's TextureLoader decodes through an <img> element (node_modules/three/src/loaders/
// ImageLoader.js:39), which a worker does not have. Colour textures load through ImageBitmapLoader
// instead, with both options written out:
// - imageOrientation 'flipY': the bitmap is flipped when it is decoded. WebGL ignores
//   UNPACK_FLIP_Y_WEBGL for ImageBitmap sources, so Texture.flipY cannot do it at upload as it does
//   for an <img>; the texture's flipY is set false to say so.
// - premultiplyAlpha 'none': ImageBitmapLoader's own default, which setOptions replaces with
//   whatever it is given (node_modules/three/src/loaders/ImageBitmapLoader.js:24, :28-30).
// three adds colorSpaceConversion 'none' itself (ImageBitmapLoader.js:93), as it disables the
// browser's conversion for an <img> upload.
//
// The sky (an EXR) loads through three's EXRLoader, which fetches the file (FileLoader) and decodes
// it in JavaScript, so it needs no DOM either.
//
// Timeouts and the load report with asset hashes come with the warm-up (plan item REN-8).
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import type { V0AssetLoaders } from '../compat/v0/index.ts'

/** The createImageBitmap options for colour textures (ADR-0003 1c) */
export const IMAGE_BITMAP_OPTIONS = Object.freeze({ imageOrientation: 'flipY', premultiplyAlpha: 'none' } as const)

export type TextureLoad = (url: string) => Promise<THREE.Texture>

/**
 * A loader of colour textures: a new Texture per call, each with its own GPU upload, as v0.3's
 * TextureLoader gave; the file is fetched and decoded once per URL and loader.
 */
export function createColorTextureLoader(manager?: THREE.LoadingManager): TextureLoad {
  const loader = new THREE.ImageBitmapLoader(manager)
  // A copy: ImageBitmapLoader writes colorSpaceConversion into the object it was given
  loader.setOptions({ ...IMAGE_BITMAP_OPTIONS })
  const bitmaps = new Map<string, Promise<ImageBitmap>>()
  return async (url: string) => {
    let bitmap = bitmaps.get(url)
    if (!bitmap) {
      bitmap = loader.loadAsync(url)
      bitmaps.set(url, bitmap)
    }
    let image: ImageBitmap
    try {
      image = await bitmap
    } catch (error) {
      bitmaps.delete(url)
      throw new Error(`texture ${url} could not be loaded: ${errorText(error)}`)
    }
    const texture = new THREE.Texture(image)
    texture.flipY = false // the bitmap was flipped when decoded (imageOrientation 'flipY')
    texture.needsUpdate = true
    return texture
  }
}

/** A loader of equirectangular EXR skies (a DataTexture, linear, half float) */
export function createSkyLoader(manager?: THREE.LoadingManager): TextureLoad {
  const loader = new EXRLoader(manager)
  return async (url: string) => {
    try {
      return await loader.loadAsync(url)
    } catch (error) {
      throw new Error(`sky ${url} could not be loaded: ${errorText(error)}`)
    }
  }
}

/** The loaders the v0 reference loader asks for (src/compat/v0/scene.ts, V0AssetLoaders) */
export function hostV0Loaders(manager?: THREE.LoadingManager): V0AssetLoaders {
  return { texture: createColorTextureLoader(manager), skybox: createSkyLoader(manager) }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
