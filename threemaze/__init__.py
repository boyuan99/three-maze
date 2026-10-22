"""threemaze: the three-maze v1 rig runtime (ADR-0002, "Rig runtime").

The Python process that serves a rig's devices, keeps the session clock, records the data and
supervises the session. It replaces the v0.3 backend (backend/src, experiments/) step by step
during phase 1; until then the two live side by side and do not share code.

Packages (layout of the backend-modules design; phase-1 subset):
    api      public names for driver authors (InputDevice, OutputDevice, register)
    core     pure parts: session states, the session clock, the records devices hand on
    runtime  the session: rig file -> devices -> IDLE ... COMPLETE | ABORTED
    devices  built-in drivers ("simulated", "serial_lines"), the serial reader and the device
             profiles (plan item DPR-03)
    link     the three-maze/link protocol to the motion worker (plan items DPR-05a, DPR-06b)
    record   the session folder (rig file copy and hash)
    config   rig file v1: loading and validation (rigs/schema/rig-v1.schema.json)

Nothing here holds a port, channel, data path or calibration constant: they come from the rig
file (docs/rig-file-v1.md).
"""

__version__ = "0.1.0"
