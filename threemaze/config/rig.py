"""Rig file v1: load, validate, apply defaults (plan item DPR-06a; docs/rig-file-v1.md).

A rig file is checked in two steps, and every problem is reported with the JSON pointer of the
field it concerns (RFC 6901, for example /devices/ball/periodUs):

1. JSON Schema 2020-12 (rigs/schema/rig-v1.schema.json): types, ranges, required and unknown
   fields, and each built-in driver's own fields;
2. what a schema cannot express: bindings name existing devices that can serve the role, the
   motion device has a calibration whose matrix fits its axes, a bound reward device has a
   safety envelope, and each driver's own checks.

The result, RigConfig, is read-only and keeps the exact bytes that were validated, so the copy
written into the session folder, and its SHA-256, are of the file the session actually used.
Defaults come from the schema's "default" keywords, never from code.

Numbers are stricter than JSON Schema alone: an "integer" field takes only a number written
without a fraction or exponent (jsonschema also counts 50000.0 as an integer, which a device
would then receive as "50000.0"), and a number too large for a double (1e400) is an error like
NaN, not infinity.
"""
import functools
import hashlib
import importlib
import json
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

import jsonschema

from ..api.registry import driver_class

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "rigs" / "schema" / "rig-v1.schema.json"

# Sections whose omitted fields take the schema's defaults (recorded with the session)
_DEFAULTED_SECTIONS = ("motion", "backend")


@dataclass(frozen=True)
class RigIssue:
    """One problem in a rig file: where (JSON pointer, "" for the whole file) and what."""

    pointer: str
    message: str

    def __str__(self) -> str:
        return f"{self.pointer or '(file)'}: {self.message}"


class RigFileError(Exception):
    """The rig file cannot be used. `issues` lists every problem found, in pointer order."""

    def __init__(self, source: str, issues: list[RigIssue]):
        self.source = source
        self.issues = issues
        lines = "\n".join(f"  {issue}" for issue in issues)
        super().__init__(f"invalid rig file {source}:\n{lines}")


@dataclass(frozen=True)
class DeviceSpec:
    name: str
    driver: str
    config: Mapping[str, Any]


@dataclass(frozen=True)
class MotionSettings:
    eye_height: float
    max_speed: float
    display_mode: str | None       # None: the motion core chooses (MOT-13)
    display_delay_us: int | None   # None: the motion core chooses (MOT-13)


@dataclass(frozen=True)
class RigConfig:
    """A validated rig file. Mappings are read-only; lists are tuples."""

    source: str
    rig_dir: Path
    raw: bytes                           # the file's bytes exactly as validated
    sha256: str                          # of raw
    data: Mapping[str, Any]              # the parsed file with defaults applied
    name: str
    devices: Mapping[str, DeviceSpec]
    bindings: Mapping[str, str]          # role -> device name
    calibration: Mapping[str, Any]       # device name -> calibration entry
    data_root: Path
    safety: Mapping[str, Any]            # role -> envelope
    backend: Mapping[str, Any]
    motion: MotionSettings

    def bound_devices(self) -> list[str]:
        """Names of the devices bound to a role, each once, in the order of the bindings."""
        return list(dict.fromkeys(self.bindings.values()))

    def to_dict(self) -> dict[str, Any]:
        """`data` as plain JSON values."""
        return _thaw(self.data)


@functools.lru_cache(maxsize=1)
def load_schema() -> dict:
    with open(SCHEMA_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _json_integer(checker: Any, instance: Any) -> bool:
    """An integer as JSON text writes it: a Python int from the parser, never a float such as
    50000.0 (which jsonschema's own "integer" accepts) and never a bool."""
    return isinstance(instance, int) and not isinstance(instance, bool)


@functools.lru_cache(maxsize=1)
def _validator_class() -> type:
    schema = load_schema()
    base = jsonschema.validators.validator_for(schema)
    base.check_schema(schema)
    return jsonschema.validators.extend(
        base, type_checker=base.TYPE_CHECKER.redefine("integer", _json_integer))


@functools.lru_cache(maxsize=1)
def _validator() -> jsonschema.protocols.Validator:
    return _validator_class()(load_schema())


def schema_defaults(section: str) -> dict[str, Any]:
    """The schema's default value of every field of a top-level section that has one."""
    props = load_schema()["properties"][section].get("properties", {})
    return {key: sub["default"] for key, sub in props.items() if "default" in sub}


def validate_fragment(instance: Any, definition: str, base: str = "") -> list[RigIssue]:
    """Validate a value against one of the schema's $defs (for example "simulatedDevice"), the
    way it is validated inside a rig file; pointers start with `base`."""
    schema = load_schema()
    sub = {"$schema": schema["$schema"], "$defs": schema["$defs"], "$ref": f"#/$defs/{definition}"}
    return _schema_issues(_validator_class()(sub), instance, base)


def load_rig(path: str | Path) -> RigConfig:
    """Read and validate a rig file. Raises RigFileError (or OSError if it cannot be read)."""
    path = Path(path)
    raw = path.read_bytes()
    return parse_rig(raw, source=str(path), rig_dir=path.resolve().parent)


def parse_rig(raw: bytes, *, source: str, rig_dir: Path) -> RigConfig:
    """Validate the bytes of a rig file; relative paths in it are relative to rig_dir."""
    importlib.import_module("threemaze.devices")  # registers the built-in drivers
    data = _parse_json(raw, source)
    issues = _duplicate_keys(data, "") + _schema_issues(_validator(), data, "")
    if not issues:
        issues = _semantic_issues(data, rig_dir)
    if issues:
        raise RigFileError(source, sorted(set(issues), key=lambda i: (i.pointer, i.message)))

    data = _plain(data)
    for section in _DEFAULTED_SECTIONS:
        values = schema_defaults(section)
        values.update(data.get(section, {}))
        data[section] = values

    root = Path(data["dataRoot"])
    motion = data["motion"]
    frozen = _freeze(data)
    return RigConfig(
        source=source,
        rig_dir=rig_dir,
        raw=bytes(raw),
        sha256=hashlib.sha256(raw).hexdigest(),
        data=frozen,
        name=data["name"],
        devices=MappingProxyType({name: DeviceSpec(name, entry["driver"], frozen["devices"][name])
                                  for name, entry in data["devices"].items()}),
        bindings=frozen["bindings"],
        calibration=frozen["calibration"],
        data_root=root if root.is_absolute() else Path(os.path.normpath(rig_dir / root)),
        safety=frozen.get("safety", MappingProxyType({})),
        backend=frozen["backend"],
        motion=MotionSettings(eye_height=motion["eyeHeight"], max_speed=motion["maxSpeed"],
                              display_mode=motion.get("displayMode"),
                              display_delay_us=motion.get("displayDelayUs")),
    )


# --- JSON -----------------------------------------------------------------------------------


class _Object(dict):
    """A JSON object that remembers keys it saw twice (json keeps only the last value)."""

    duplicates: list[str]


def _object_hook(pairs: list[tuple[str, Any]]) -> _Object:
    obj = _Object()
    obj.duplicates = []
    for key, value in pairs:
        if key in obj:
            obj.duplicates.append(key)
        obj[key] = value
    return obj


class _NotANumber(ValueError):
    pass


def _reject_constant(name: str) -> Any:
    raise _NotANumber(f"{name} is not a JSON number")


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise _NotANumber(f"{text} is beyond the range of a number")
    return value


def _parse_json(raw: bytes, source: str) -> Any:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise RigFileError(source, [RigIssue("", f"not UTF-8 text: {exc}")]) from None
    try:
        return json.loads(text, object_pairs_hook=_object_hook, parse_constant=_reject_constant,
                          parse_float=_finite_float)
    except json.JSONDecodeError as exc:
        message = f"not valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})"
        raise RigFileError(source, [RigIssue("", message)]) from None
    except _NotANumber as exc:
        raise RigFileError(source, [RigIssue("", f"not valid JSON: {exc}")]) from None


def _duplicate_keys(value: Any, pointer: str) -> list[RigIssue]:
    found = []
    if isinstance(value, _Object):
        found += [RigIssue(_join(pointer, key), "key given twice; remove one")
                  for key in dict.fromkeys(value.duplicates)]
        for key, item in value.items():
            found += _duplicate_keys(item, _join(pointer, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found += _duplicate_keys(item, _join(pointer, index))
    return found


def _join(pointer: str, token: Any) -> str:
    return f"{pointer}/{str(token).replace('~', '~0').replace('/', '~1')}"


def _pointer(path: Any) -> str:
    out = ""
    for token in path:
        out = _join(out, token)
    return out


def _plain(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


def _freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


# --- step 1: the schema -----------------------------------------------------------------------


def _schema_issues(validator: Any, data: Any, base: str) -> list[RigIssue]:
    issues = []
    for error in validator.iter_errors(data):
        pointer = base + _pointer(error.absolute_path)
        instance = error.instance
        if error.validator == "required":
            for key in error.validator_value:
                if isinstance(instance, dict) and key not in instance:
                    issues.append(RigIssue(_join(pointer, key), "missing (required)"))
        elif error.validator == "additionalProperties" and isinstance(instance, dict):
            allowed = list(error.schema.get("properties", {}))
            for key in instance:
                if key not in allowed:
                    hint = f"; allowed here: {', '.join(allowed)}" if allowed else ""
                    issues.append(RigIssue(_join(pointer, key), f"unknown field{hint}"))
        elif "propertyNames" in error.relative_schema_path:
            issues.append(RigIssue(_join(pointer, instance), f"invalid name: {error.message}"))
        else:
            issues.append(RigIssue(pointer, error.message))
    return issues


# --- step 2: what the schema cannot express ---------------------------------------------------


def _semantic_issues(data: dict, rig_dir: Path) -> list[RigIssue]:
    issues = []
    devices = data["devices"]
    calibration = data["calibration"]
    bindings = data["bindings"]

    for name, entry in devices.items():
        cls = driver_class(entry["driver"])
        if cls is None:  # listed in the schema but not registered: a packaging error
            issues.append(RigIssue(f"/devices/{name}/driver",
                                   f"driver {entry['driver']!r} is not available"))
            continue
        for suffix, message in cls.check_config(entry, rig_dir):
            issues.append(RigIssue(f"/devices/{name}{suffix}", message))

    for role, name in bindings.items():
        if name not in devices:
            known = ", ".join(devices)
            issues.append(RigIssue(f"/bindings/{role}",
                                   f"no device named {name!r} (devices: {known})"))
            continue
        cls = driver_class(devices[name]["driver"])
        if cls is not None and role not in cls.roles(devices[name]):
            issues.append(RigIssue(
                f"/bindings/{role}",
                f"device {name!r} cannot serve the {role} role with its configuration"
                f" (it can serve: {', '.join(sorted(cls.roles(devices[name]))) or 'none'})"))

    for name in calibration:
        if name not in devices:
            issues.append(RigIssue(f"/calibration/{name}", f"no device named {name!r} in /devices"))

    motion = bindings.get("motion")
    if motion in devices and motion not in calibration:
        issues.append(RigIssue(f"/calibration/{motion}",
                               "missing: the motion device needs its calibration matrix"))

    for name, entry in calibration.items():
        widths = [len(row) for row in entry["matrix"]]
        pointer = f"/calibration/{name}/matrix"
        if len(set(widths)) > 1:
            issues.append(RigIssue(pointer, f"rows have {widths} columns; every row needs one column"
                                            " per sensor axis"))
            continue
        cls = driver_class(devices[name]["driver"]) if name in devices else None
        axes = cls.axis_count(devices[name]) if cls is not None else None
        if axes is not None and widths[0] != axes:
            issues.append(RigIssue(pointer, f"has {widths[0]} columns, but device {name!r} has {axes}"
                                            " sensor axes"))

    if "reward" in bindings and "reward" not in data.get("safety", {}):
        issues.append(RigIssue("/safety/reward",
                               "missing: a rig with a reward device needs its safety envelope"))
    return issues
