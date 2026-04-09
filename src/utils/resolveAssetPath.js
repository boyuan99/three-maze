/**
 * Resolves an asset path relative to a maze's base directory.
 * - Absolute paths (starting with / or http) are returned as-is
 * - Legacy @/ alias paths are converted to absolute /
 * - Relative paths are resolved against the provided basePath
 */
export function resolveAssetPath(assetPath, basePath = '') {
  if (assetPath.startsWith('/') || assetPath.startsWith('http')) return assetPath
  if (assetPath.startsWith('@/')) return assetPath.replace('@/', '/')
  return '/' + basePath + assetPath
}
