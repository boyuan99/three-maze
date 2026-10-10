"""THREEMAZE_SIM_DEVICE: what the simulated serial device does beyond the defaults.

The file is JSON with the fields of a rig file's simulated device (rigs/schema/rig-v1.schema.json,
$defs/simulatedDevice; docs/rig-file-v1.md), checked by the same schema and the same rules, with
file names relative to the file's folder. It is read when the sim activates: a file that does not
check out stops the process with exit code 86, like any other misconfiguration.

- THREEMAZE_SIM_PROTOCOL=v1 (needs the file): the port speaks device protocol v1 with that device
  (deviceId required; driver may be left out).
- THREEMAZE_SIM_PROTOCOL=legacy-v0.3 (the default) with the file: the 13-field stream takes x, y,
  theta (fields 7, 8, 9) and the lick value (field 10) from the file's trajectory, at the period of
  the init line; only `sensor` and `trajectory` are allowed then, and THREEMAZE_SIM_SPEED must stay
  1. Without the file, the stream is v0.3's simulated running, unchanged.

The device model is threemaze/devices/sim, imported from the repository this sim belongs to.
"""
import json
import os
import sys

from . import config

LEGACY_KEYS = ("sensor", "trajectory")


def _threemaze():
    """Import the rig runtime's sim package (appending the repository root to sys.path if this
    process cannot see it yet; appended, so nothing the process imports is shadowed)."""
    try:
        import threemaze.devices.sim as sim
    except ImportError:
        if config.REPO_ROOT not in sys.path:
            sys.path.append(config.REPO_ROOT)
        import threemaze.devices.sim as sim
    from threemaze.config import validate_fragment
    return sim, validate_fragment


def resolver(device_file):
    base = os.path.dirname(device_file)

    def resolve(path):
        from pathlib import Path
        p = Path(path)
        return p if p.is_absolute() else Path(base) / p
    return resolve


def load(settings):
    """The checked device entry, or None when there is no THREEMAZE_SIM_DEVICE. Raises
    config.SimConfigError."""
    if settings.device_file is None:
        if settings.protocol == "v1":
            raise config.SimConfigError("THREEMAZE_SIM_PROTOCOL=v1 needs THREEMAZE_SIM_DEVICE, a JSON file"
                                        " describing the simulated device")
        return None
    try:
        with open(settings.device_file, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        raise config.SimConfigError(f"THREEMAZE_SIM_DEVICE={settings.device_file!r}: {exc}") from None
    if not isinstance(data, dict):
        raise config.SimConfigError(f"THREEMAZE_SIM_DEVICE={settings.device_file!r}: not a JSON object")
    if settings.protocol == "v1":
        entry = {"driver": "simulated", **data}
        if entry["driver"] != "simulated":
            raise config.SimConfigError(f"THREEMAZE_SIM_DEVICE={settings.device_file!r}: driver must be"
                                        " 'simulated'")
    else:
        extra = sorted(set(data) - set(LEGACY_KEYS))
        if extra:
            raise config.SimConfigError(f"THREEMAZE_SIM_DEVICE={settings.device_file!r}: {', '.join(extra)}"
                                        f" not used by the legacy-v0.3 stream (allowed: {', '.join(LEGACY_KEYS)})")
        if settings.speed != 1:
            raise config.SimConfigError("THREEMAZE_SIM_SPEED applies to the default motion only; the"
                                        " device file's trajectory sets the motion")
        entry = legacy_entry(data, config.DEFAULT_PERIOD_MS * 1000)
    sim, validate_fragment = _threemaze()
    problems = [str(issue) for issue in validate_fragment(entry, "simulatedDevice")]
    if not problems:
        problems = [f"{pointer or '(device)'}: {message}" for pointer, message in sim.config_problems(entry)]
    if not problems:
        try:
            sim.config_from_entry(entry, resolver(settings.device_file))
        except sim.MotionError as exc:
            problems.append(str(exc))
    if problems:
        raise config.SimConfigError(f"THREEMAZE_SIM_DEVICE={settings.device_file!r}: " + "; ".join(problems))
    return data


def v1_entry(settings):
    """The simulated-device entry of the v1 device."""
    return {"driver": "simulated", **settings.device}


def legacy_entry(data, period_us):
    """The simulated-device entry the legacy stream's motion comes from, at the init line's period."""
    return {"driver": "simulated", "deviceId": "sim-legacy", "periodUs": period_us, **data}


def legacy_motion(settings, period_us):
    """A fresh motion source for one legacy stream, or None for v0.3's default running."""
    if settings.device is None or "trajectory" not in settings.device:
        return None
    sim, _ = _threemaze()
    entry = legacy_entry(settings.device, period_us)
    return sim.config_from_entry(entry, resolver(settings.device_file)).motion()
