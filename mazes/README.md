# Scene Configuration Guide

## Asset Path Format

All asset paths in scene JSON files use the **absolute format** starting from `/src/`:

### ✅ Standard Format (Implemented)

```json
{
  "skybox": "/src/assets/evening_road_01_puresky_1k.exr",
  "material": {
    "map": "/src/assets/Chess_Pattern.jpg"
  }
}
```

**Status**: All JSON files have been updated to use this format (2025-10-24).

### ❌ Old Deprecated Formats (no longer used)

```json
{
  "skybox": "/assets/evening_road_01_puresky_1k.exr",  // Missing /src/
  "skybox": "@/assets/background.exr",                 // Old alias format
  "material": {
    "map": "/assets/textures/Chess_Pattern.jpg"       // Wrong subdirectory
  }
}
```

**Note**: Path conversion code has been removed. JSON files must use the correct format.

## File Structure

```
three-maze/
  src/
    assets/
      Chess_Pattern.jpg              ← Textures here (no subdirectory)
      evening_road_01_puresky_1k.exr ← HDR backgrounds here
      ...
  mazes/
    Hallway02.json                   ← Scene configs here
    ...
```

## Common Assets

### Textures
- `/src/assets/Chess_Pattern.jpg` - Black and white checkerboard pattern

### HDR Backgrounds
- `/src/assets/evening_road_01_puresky_1k.exr` - Evening sky

## Scene JSON Template

```json
{
  "name": "My Scene",
  "description": "Scene description",
  "camera": {
    "position": {"x": 0, "y": 1.6, "z": 0},
    "fov": 75
  },
  "skybox": "/src/assets/evening_road_01_puresky_1k.exr",
  "lights": [
    {
      "type": "ambient",
      "color": 16777215,
      "intensity": 0.5
    }
  ],
  "objects": [
    {
      "name": "floor",
      "geometry": {
        "type": "box",
        "width": 40,
        "height": 1,
        "depth": 100
      },
      "material": {
        "map": "/src/assets/Chess_Pattern.jpg",
        "repeat": {"x": 0.4, "y": 1.0},
        "roughness": 0.8
      },
      "position": {"x": 0, "y": -0.5, "z": 0},
      "physics": {
        "enabled": true,
        "type": "static"
      }
    }
  ]
}
```

## Notes

- All paths are case-sensitive
- Use forward slashes `/` even on Windows
- Texture files should be in standard formats (JPG, PNG)
- HDR backgrounds should be in EXR format
