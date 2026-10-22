"""Reading what a client sends (link protocol v1, protocol/v1/SPEC.md sections 4.4 and 12).

read_frame() parses one WebSocket frame and checks it as a tolerant receiver (E5): unknown
properties are ignored, anything else the schemas forbid is reported (validate.py). The two
messages a motion client sends most often, heartbeat (every 20 ms) and pose.batch (about every
20 ms, up to 1000 poses), take a fast path: a direct check of exactly the fields of their schemas,
which accepts only messages the schemas accept and hands everything else to the full validator
(about 0.1 ms per pose with jsonschema, which would hold up the samples on the same event loop).
A test holds the fast path to the full validator on the protocol's examples and their mutations.
"""
import json
import math
import re
from typing import Any

from .validate import (LINK_MESSAGE_TYPES, LINK_SCHEMAS, LinkIssue, _parse_int, _reject_constant,
                       link_errors)

MAX_INT = (1 << 53) - 1
MAX_SEQ = (1 << 32) - 1
_ID = re.compile(LINK_SCHEMAS["common.schema.json"]["$defs"]["id"]["pattern"])
EVENT_KINDS = frozenset(
    LINK_SCHEMAS["event.schema.json"]["$defs"]["data"]["properties"]["kind"]["enum"])
REPORT_KINDS = frozenset(
    LINK_SCHEMAS["render.report.schema.json"]["$defs"]["data"]["properties"]["kind"]["enum"])
_POSE_KEYS = frozenset(LINK_SCHEMAS["pose.batch.schema.json"]["$defs"]["pose"]["properties"])
_ENVELOPE = frozenset(("type", "t", "data"))


def _uint(value: Any, high: int = MAX_INT) -> bool:
    return type(value) is int and 0 <= value <= high


def _number(value: Any) -> bool:
    if type(value) is float:
        return math.isfinite(value)
    return type(value) is int and -MAX_INT <= value <= MAX_INT


def heartbeat_ok(message: dict) -> bool:
    """True only for a heartbeat its schema accepts, with no property it does not name."""
    if message.keys() != _ENVELOPE or not _uint(message["t"]):
        return False
    data = message["data"]
    if type(data) is not dict or not _uint(data.get("n")):
        return False
    for key, value in data.items():
        if key == "last_seq":
            if not _uint(value, MAX_SEQ):
                return False
        elif key == "epoch":
            if not _uint(value):
                return False
        elif key != "n":
            return False
    return True


def pose_batch_ok(message: dict) -> bool:
    """True only for a pose.batch its schema accepts, with no property it does not name."""
    if message.keys() != _ENVELOPE or not _uint(message["t"]):
        return False
    data = message["data"]
    if type(data) is not dict or data.keys() != {"world", "poses"}:
        return False
    world, poses = data["world"], data["poses"]
    if type(world) is not str or not _ID.search(world):
        return False
    if type(poses) is not list or not 1 <= len(poses) <= 1000:
        return False
    for pose in poses:
        if (type(pose) is not dict or pose.keys() != _POSE_KEYS
                or not _uint(pose["seq"], MAX_SEQ) or not _uint(pose["epoch"])
                or not _uint(pose["t_dev_us"])
                or not (_number(pose["x"]) and _number(pose["feet_y"]) and _number(pose["z"])
                        and _number(pose["yaw"]))
                or type(pose["contact"]) is not bool or type(pose["airborne"]) is not bool):
            return False
    return True


_FAST = {"heartbeat": heartbeat_ok, "pose.batch": pose_batch_ok}


def read_frame(frame: str | bytes) -> tuple[Any, list[LinkIssue]]:
    """(value, []) for a valid message; (value, issues) otherwise, where value is the parsed JSON
    (None if the frame is not JSON text), so that the caller can tell an unknown type or kind
    (E5) from a malformed message (Q2)."""
    if not isinstance(frame, str):
        return None, [LinkIssue("", "json", "a binary frame: every message is a text frame")]
    try:
        value = json.loads(frame, parse_constant=_reject_constant, parse_int=_parse_int)
    except ValueError as err:          # json.JSONDecodeError is a ValueError
        return None, [LinkIssue("", "json", f"not JSON: {err}")]
    if type(value) is dict:
        fast = _FAST.get(value.get("type"))
        if fast is not None and fast(value):
            return value, []
    return value, link_errors(value, tolerant=True)


def unknown_kind(value: Any) -> str | None:
    """What a receiver does not know in an invalid message (E5): "type" for a message type of a
    later version, "kind" for an event or render-report kind it does not know; else None."""
    if type(value) is not dict or type(value.get("type")) is not str:
        return None
    if value["type"] not in LINK_MESSAGE_TYPES:
        return "type"
    data = value.get("data")
    kind = data.get("kind") if type(data) is dict else None
    if type(kind) is str and ((value["type"] == "event" and kind not in EVENT_KINDS)
                              or (value["type"] == "render.report" and kind not in REPORT_KINDS)):
        return "kind"
    return None
