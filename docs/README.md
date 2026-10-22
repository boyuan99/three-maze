# Documentation

- [Device protocol v1](protocol/device-v1.md): what a motion or output device must send to the rig runtime and why, the guarantee levels a session records, and the profile that reads the v0.3 device stream.
- [Movement and collision limits](movement-and-collision-limits.md): how the avatar moves through a scene, the limits scene authors must respect, and why they exist.
- [Rig file v1](rig-file-v1.md): the file that describes a rig (devices, roles, calibration, data folder, safety limits, eye height) to the v1 rig runtime.
- [Architecture decision records](adr/README.md): the design decisions that three-maze v1.0 is built on, with their evidence.
- [Week-6 gate: analysis pre-specification](timing/gate-analysis.md): how missed frames are counted and how the render-worker promotion gate (ADR-0003) is decided, fixed before the gate data exist.
