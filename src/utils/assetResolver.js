/**
 * Resolves texture paths for maze assets
 * Supports both legacy absolute paths (/src/assets/...) and local relative paths (assets/...)
 */

export class AssetResolver {
  constructor(mazeDir = null) {
    this.mazeDir = mazeDir
    this.isElectron = !!window.electron
  }

  /**
   * Resolves an asset path to a loadable URL
   * @param {string} assetPath - The path from the maze JSON
   * @returns {Promise<string>} - Resolved URL for loading
   */
  async resolve(assetPath) {
    if (!assetPath) return null

    // Check if it's already a full URL or data URL
    if (assetPath.startsWith('http://') || assetPath.startsWith('https://') || assetPath.startsWith('file://') || assetPath.startsWith('data:')) {
      return assetPath
    }

    // Check if it's a legacy absolute path (starts with /)
    if (assetPath.startsWith('/')) {
      // Legacy path like /src/assets/Chess_Pattern.jpg
      // In dev mode, Vite serves this; in production, it's bundled
      return assetPath
    }

    // Relative path - resolve using maze directory
    if (this.isElectron && this.mazeDir && window.electron.resolveMazeAsset) {
      const resolved = await window.electron.resolveMazeAsset(this.mazeDir, assetPath)
      if (resolved) {
        return resolved
      }
      // Fallback if resolution fails
      console.warn(`Could not resolve local asset: ${assetPath}, falling back to default behavior`)
    }

    // Fallback for non-Electron or if resolution fails
    // Try treating it as a path relative to the public directory
    return assetPath
  }

  /**
   * Creates a resolver instance from a scene config
   */
  static fromConfig(config) {
    return new AssetResolver(config?._mazeDir || null)
  }
}
