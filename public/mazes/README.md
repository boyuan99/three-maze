# Maze Scene Configuration

This folder contains JSON configuration files for maze scenes.


## File Structure

Each scene should be organized as a folder with the following structure:

```
SceneName/
  SceneName.json                     ← Scene configuration file
  assets/                             ← Scene-specific assets folder
    texture.jpg
    background.exr
    ...
```

The JSON configuration file should have the same name as the folder.



## Notes

- All paths are case-sensitive
- Use forward slashes `/` even on Windows
- Texture files should be in standard formats (JPG, PNG)
- HDR backgrounds should be in EXR format
