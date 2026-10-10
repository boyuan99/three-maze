"""Validator for the link protocol v1 (protocol/v1/SPEC.md).

Checks a message against the JSON Schemas in protocol/v1 with jsonschema (draft 2020-12). It is the
Python twin of src/protocol/validate.js: both report the same problems in the same form
(LinkIssue(path, keyword, message), sorted by path and keyword) and accept and reject the same
messages, which test/backend/test_link_protocol.py and test/frontend/protocol check on the shared
examples in protocol/v1/examples.

Senders validate strictly. A receiver may pass tolerant=True, which ignores properties the schemas
do not know, as a newer minor version may add them (SPEC.md section 4.4).

    from threemaze.link.validate import link_errors, parse_link_message
    message, errors = parse_link_message(frame_text)

The schemas are read from the source checkout (protocol/v1 next to this package), the way the rig
runs three-maze.
"""
import copy
import json
import math
from pathlib import Path
from typing import NamedTuple

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "protocol" / "v1"
MESSAGE_SCHEMA = "message.schema.json"


class LinkIssue(NamedTuple):
    """One problem in a message.

    path: JSON Pointer to the offending value, "" for the message itself.
    keyword: the JSON Schema keyword that failed, or "json" for text that is not JSON.
    """

    path: str
    keyword: str
    message: str


def _load_schemas():
    schemas = {}
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        with open(path, encoding="utf-8") as fh:
            schemas[path.name] = json.load(fh)
    return schemas


LINK_SCHEMAS = _load_schemas()
"""Every schema file of protocol/v1 by file name; message.schema.json validates a whole message."""

LINK_MESSAGE_TYPES = tuple(LINK_SCHEMAS[MESSAGE_SCHEMA]["properties"]["type"]["enum"])
"""The message types of version 1, in the order of message.schema.json."""

_WELCOME = LINK_SCHEMAS["welcome.schema.json"]["$defs"]["data"]["properties"]
HEARTBEAT_MS = _WELCOME["heartbeat_ms"]["const"]
"""Heartbeat interval in ms, as welcome announces it (SPEC.md section 6)."""
WATCHDOG_MS = _WELCOME["watchdog_ms"]["const"]
"""Watchdog limit in ms, as welcome announces it (SPEC.md section 6)."""


def _relax(node):
    """A copy of a schema without its additionalProperties and unevaluatedProperties that are
    false, for tolerant receivers."""
    if isinstance(node, list):
        return [_relax(item) for item in node]
    if not isinstance(node, dict):
        return node
    return {
        key: _relax(value)
        for key, value in node.items()
        if not (key in ("additionalProperties", "unevaluatedProperties") and value is False)
    }


_validators = {}


def _validator(tolerant):
    validator = _validators.get(tolerant)
    if validator is None:
        schemas = {
            name: (_relax(schema) if tolerant else copy.deepcopy(schema))
            for name, schema in LINK_SCHEMAS.items()
        }
        registry = Registry().with_resources(
            (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
        )
        validator = Draft202012Validator(schemas[MESSAGE_SCHEMA], registry=registry)
        _validators[tolerant] = validator
    return validator


def _pointer(parts):
    return "".join(
        "/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts
    )


def _non_finite(value, path, out):
    """Numbers that are not finite doubles, anywhere in a value: json.loads turns 1e400 into inf, a
    dict built in code can hold nan, and an integer beyond the largest double (about 1.8e308) stays
    an exact int in Python where JSON.parse makes it Infinity. jsonschema's number type admits all
    three."""
    if isinstance(value, float):
        if not math.isfinite(value):
            out.append(LinkIssue(path, "type", "must be a finite number"))
    elif isinstance(value, int) and not isinstance(value, bool):
        try:
            float(value)
        except OverflowError:
            out.append(LinkIssue(path, "type", "must be a finite number"))
    elif isinstance(value, list):
        for i, item in enumerate(value):
            _non_finite(item, f"{path}/{i}", out)
    elif isinstance(value, dict):
        for key, item in value.items():
            _non_finite(item, path + _pointer([key]), out)


def _tidy(issues):
    """One issue per path and keyword, sorted by path and keyword."""
    seen = {}
    for issue in issues:
        seen.setdefault((issue.path, issue.keyword), issue)
    return [seen[key] for key in sorted(seen)]


def link_errors(value, tolerant=False):
    """The problems that make value (a parsed message) an invalid link message; [] if valid.

    tolerant: ignore properties the schemas do not know.
    """
    issues = []
    _non_finite(value, "", issues)
    # Ajv's type check fails first on a non-finite number and skips that value's other keywords;
    # jsonschema would also report, say, maximum for inf, so those reports are left out
    non_finite = {issue.path for issue in issues}
    for error in _validator(tolerant).iter_errors(value):
        path = _pointer(error.absolute_path)
        if path not in non_finite:
            issues.append(LinkIssue(path, str(error.validator), error.message))
    return _tidy(issues)


def is_link_message(value):
    """True if value is a valid link message (strict)."""
    return not link_errors(value)


def _reject_constant(name):
    raise ValueError(f"{name} is not JSON")


def _parse_int(digits):
    """An integer literal, read so that the result matches JSON.parse's: int() refuses more than
    4300 digits (sys.get_int_max_str_digits()), where JavaScript reads Infinity, so such a literal
    becomes a float, which is inf as well."""
    try:
        return int(digits)
    except ValueError:
        return float(digits)


def parse_link_message(text, tolerant=False):
    """Parses one message from the text of a WebSocket frame and validates it.

    Returns (message, []) for a valid message, else (None, issues). NaN and Infinity are not JSON
    and are refused, unlike json.loads' default; a number too large for a double is reported as not
    finite, as JavaScript reads it.
    """
    try:
        value = json.loads(text, parse_constant=_reject_constant, parse_int=_parse_int)
    except ValueError as err:          # json.JSONDecodeError is a ValueError
        return None, [LinkIssue("", "json", f"not JSON: {err}")]
    errors = link_errors(value, tolerant=tolerant)
    return (None, errors) if errors else (value, [])
