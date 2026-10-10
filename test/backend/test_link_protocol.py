"""Link protocol v1 (protocol/v1/SPEC.md), Python side, and the schemas themselves.

- threemaze/link/validate.py accepts every example in protocol/v1/examples and reports exactly the
  problems that protocol/v1/examples/expected-errors.json lists for each malformed one. The
  JavaScript validator is held to the same file (test/frontend/protocol/linkProtocol.test.ts), so
  both report the same problems.
- The schemas are valid draft 2020-12 schemas; every string they allow is an enum, a constant or
  patterned (so no file path or .py name can travel unchecked, SPEC.md section 4.3); every
  required name is defined; the message types stay within the budget of 12.
"""
import json
import math
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from threemaze.link.validate import (
    HEARTBEAT_MS,
    LINK_MESSAGE_TYPES,
    LINK_SCHEMAS,
    WATCHDOG_MS,
    is_link_message,
    link_errors,
    parse_link_message,
)

REPO = Path(__file__).resolve().parents[2]
PROTOCOL = REPO / "protocol" / "v1"
EXAMPLES = PROTOCOL / "examples"
EXPECTED = json.loads((EXAMPLES / "expected-errors.json").read_text(encoding="utf-8"))["cases"]
VALID = sorted(p.name for p in EXAMPLES.glob("*.json") if p.name != "expected-errors.json")
MALFORMED = sorted(
    [f"invalid/{p.name}" for p in (EXAMPLES / "invalid").glob("*.json")]
    + [f"invalid-text/{p.name}" for p in (EXAMPLES / "invalid-text").glob("*.txt")]
)


def read(rel):
    return (EXAMPLES / rel).read_text(encoding="utf-8")


def pairs(issues):
    return [{"path": issue.path, "keyword": issue.keyword} for issue in issues]


# ---- examples ---------------------------------------------------------------------------------

@pytest.mark.parametrize("name", VALID)
def test_valid_example_is_accepted(name):
    text = read(name)
    message = json.loads(text)
    assert link_errors(message) == []
    assert is_link_message(message)
    assert parse_link_message(text) == (message, [])
    assert name.removesuffix(".json").split("--")[0] == message["type"]


def test_valid_examples_cover_every_type_and_kind():
    messages = [json.loads(read(name)) for name in VALID]
    assert {m["type"] for m in messages} == set(LINK_MESSAGE_TYPES)
    for type_, schema in (("event", "event"), ("render.report", "render.report")):
        kinds = {m["data"]["kind"] for m in messages if m["type"] == type_}
        enum = LINK_SCHEMAS[f"{schema}.schema.json"]["$defs"]["data"]["properties"]["kind"]["enum"]
        assert kinds == set(enum)


def test_every_malformed_example_is_listed_and_every_listed_case_exists():
    assert MALFORMED == sorted(EXPECTED)
    assert len(MALFORMED) >= 50


@pytest.mark.parametrize("rel", MALFORMED)
def test_malformed_example_is_rejected_with_the_listed_problems(rel):
    text = read(rel)
    message, issues = parse_link_message(text)
    assert message is None
    assert pairs(issues) == EXPECTED[rel]["issues"]
    if rel.startswith("invalid/"):
        assert not is_link_message(json.loads(text))
        assert pairs(link_errors(json.loads(text))) == EXPECTED[rel]["issues"]


# ---- numbers ----------------------------------------------------------------------------------

def heartbeat(n):
    return {"type": "heartbeat", "t": 5, "data": {"n": n}}


def test_non_finite_numbers_are_rejected_where_code_built_them():
    assert [tuple(i) for i in link_errors(heartbeat(math.nan))] == [
        ("/data/n", "type", "must be a finite number")
    ]
    assert pairs(link_errors(heartbeat(math.inf))) == [{"path": "/data/n", "keyword": "type"}]
    pose = json.loads(read("pose.batch.json"))
    pose["data"]["poses"][1]["yaw"] = -math.inf
    assert pairs(link_errors(pose)) == [{"path": "/data/poses/1/yaw", "keyword": "type"}]


def test_nan_and_infinity_in_text_are_not_json():
    for text in ('{"type": "heartbeat", "t": 5, "data": {"n": NaN}}',
                 '{"type": "heartbeat", "t": 5, "data": {"n": -Infinity}}'):
        message, issues = parse_link_message(text)
        assert message is None and pairs(issues) == [{"path": "", "keyword": "json"}]


def test_integers_beyond_2_53_and_fractions_are_rejected():
    assert pairs(link_errors(heartbeat(2 ** 53))) == [{"path": "/data/n", "keyword": "maximum"}]
    assert pairs(link_errors(heartbeat(1.5))) == [{"path": "/data/n", "keyword": "type"}]
    assert pairs(link_errors(heartbeat(True))) == [{"path": "/data/n", "keyword": "type"}]
    assert link_errors(heartbeat(2 ** 53 - 1)) == []


def test_integers_too_large_for_a_double_are_not_finite():
    # JSON.parse reads them as Infinity (linkProtocol.test.ts); int() refuses over 4300 digits
    for digits in ("1" + "0" * 400, "1" * 5000, "-" + "1" * 5000):
        text = '{"type": "heartbeat", "t": 5, "data": {"n": %s}}' % digits
        message, issues = parse_link_message(text)
        assert message is None and pairs(issues) == [{"path": "/data/n", "keyword": "type"}]
    assert pairs(link_errors(heartbeat(-10 ** 400))) == [{"path": "/data/n", "keyword": "type"}]


# ---- text -------------------------------------------------------------------------------------

def test_text_is_one_line_without_control_characters_or_line_separators():
    def error(message):
        return {"type": "error", "t": 5, "data": {"code": "internal", "message": message}}

    for c in ("\n", "\u007f", "\u0085", "\u009f", "\u2028", "\u2029"):
        assert pairs(link_errors(error(f"a{c}b"))) == [
            {"path": "/data/message", "keyword": "pattern"}
        ], repr(c)
    assert link_errors(error("a\u00a0b, (c) 1.5 \u00b5s")) == []


# ---- tolerant receivers -----------------------------------------------------------------------

def newer_event():
    message = json.loads(read("event--zone-enter.json"))
    message["hint"] = "from 1.1"
    message["data"]["speed_cm_s"] = 12.5
    return message


def test_tolerant_receiver_ignores_properties_of_a_newer_minor_version():
    assert pairs(link_errors(newer_event())) == [
        {"path": "", "keyword": "additionalProperties"},
        {"path": "/data", "keyword": "unevaluatedProperties"},
    ]
    assert link_errors(newer_event(), tolerant=True) == []
    sample = json.loads(read("sample.batch--v1-device.json"))
    sample["data"]["samples"][0]["t_host_us"] = 512340377
    assert link_errors(sample, tolerant=True) == []
    assert parse_link_message(json.dumps(newer_event()), tolerant=True)[1] == []


def test_tolerant_receiver_still_rejects_what_the_schemas_forbid():
    message = newer_event()
    del message["data"]["edge"]
    message["data"]["epoch"] = -1
    assert pairs(link_errors(message, tolerant=True)) == [
        {"path": "/data", "keyword": "required"},
        {"path": "/data/epoch", "keyword": "minimum"},
    ]


# ---- constants and budget ---------------------------------------------------------------------

def test_heartbeat_gives_at_least_five_beats_per_watchdog_window():
    assert (HEARTBEAT_MS, WATCHDOG_MS) == (20, 100)
    assert WATCHDOG_MS / HEARTBEAT_MS >= 5


def test_core_message_types_stay_within_the_budget_of_12():
    # ten in the core subset; plan item DPR-05b adds at most two (SPEC.md section 3)
    assert len(LINK_MESSAGE_TYPES) == 10
    assert len(LINK_MESSAGE_TYPES) + 2 <= 12
    assert {f"{t}.schema.json" for t in LINK_MESSAGE_TYPES} | {
        "common.schema.json", "message.schema.json"} == set(LINK_SCHEMAS)


# ---- the schemas themselves -------------------------------------------------------------------

def walk(node, where):
    """Every schema node under node, with a readable location."""
    if not isinstance(node, dict):
        return
    yield node, where
    for key in ("properties", "$defs"):
        for name, sub in node.get(key, {}).items():
            yield from walk(sub, f"{where}/{key}/{name}")
    for key in ("allOf", "anyOf", "prefixItems"):
        for i, sub in enumerate(node.get(key, [])):
            yield from walk(sub, f"{where}/{key}/{i}")
    for key in ("items", "additionalProperties", "unevaluatedProperties", "propertyNames", "if",
                "then"):
        if key in node:
            yield from walk(node[key], f"{where}/{key}")


@pytest.mark.parametrize("name", sorted(LINK_SCHEMAS))
def test_schema_is_a_valid_2020_12_schema_with_its_file_id(name):
    schema = LINK_SCHEMAS[name]
    Draft202012Validator.check_schema(schema)
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$id"] == f"https://three-maze.example/link/v1/{name}"


def test_every_string_the_schemas_allow_is_an_enum_a_constant_or_patterned():
    for name, schema in LINK_SCHEMAS.items():
        for node, where in walk(schema, name):
            if node.get("type") == "string":
                assert "pattern" in node or "enum" in node or "const" in node, where


def test_every_pattern_ends_at_the_true_end_of_the_string():
    # Python's $ also matches before a final newline; Ajv's does not
    for name, schema in LINK_SCHEMAS.items():
        for node, where in walk(schema, name):
            if "pattern" in node:
                assert node["pattern"].startswith("^"), where
                assert node["pattern"].endswith(r"(?![\s\S])"), where


def test_every_required_name_is_defined():
    for name, schema in LINK_SCHEMAS.items():
        for node, where in walk(schema, name):
            defined = set(node.get("properties", {}))
            for i, branch in enumerate(node.get("allOf", [])):
                then = branch.get("then", {}) if isinstance(branch, dict) else {}
                for required in then.get("required", []):
                    # a branch may require a property that its parent or the branch defines
                    assert required in defined | set(then.get("properties", {})), \
                        f"{where}/allOf/{i}/then: {required}"
            if not where.endswith("/then") and "required" in node:
                for required in node["required"]:
                    assert required in defined, f"{where}: {required}"


def test_message_schema_dispatches_every_type_to_its_own_schema():
    message = LINK_SCHEMAS["message.schema.json"]
    targets = {
        branch["if"]["properties"]["type"]["const"]: branch["then"]["$ref"]
        for branch in message["allOf"]
    }
    assert targets == {t: f"{t}.schema.json" for t in LINK_MESSAGE_TYPES}
    for t in LINK_MESSAGE_TYPES:
        schema = LINK_SCHEMAS[f"{t}.schema.json"]
        assert schema["properties"]["type"] == {"const": t}
        assert schema["additionalProperties"] is False
