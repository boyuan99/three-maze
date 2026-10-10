"""Rig file v1: validation with field-level errors (JSON pointers), defaults from the schema, and
a read-only result that keeps the exact bytes validated (plan item DPR-06a)."""
import hashlib
import json

import jsonschema
import pytest

from threemaze.api.registry import driver_names
from threemaze.config import RigFileError, load_rig
from threemaze.config.rig import SCHEMA_PATH, load_schema


def pointers(excinfo):
    return [issue.pointer for issue in excinfo.value.issues]


def messages(excinfo):
    return {issue.pointer: issue.message for issue in excinfo.value.issues}


def test_sim_rig_is_valid(sim_rig_path):
    rig = load_rig(sim_rig_path)
    raw = sim_rig_path.read_bytes()
    assert rig.name == "sim"
    assert rig.raw == raw
    assert rig.sha256 == hashlib.sha256(raw).hexdigest()
    assert dict(rig.bindings) == {"motion": "ball", "reward": "valve"}
    assert rig.bound_devices() == ["ball", "valve"]
    assert rig.devices["ball"].driver == "simulated"
    assert rig.data_root == (sim_rig_path.parent.parent / "data")
    assert rig.motion.eye_height == 3.7


def test_defaults_come_from_the_schema(sim_rig_data, write_rig):
    del sim_rig_data["motion"]
    rig = load_rig(write_rig(sim_rig_data))
    # ADR-0001 R3 (eye height 3.7) and Decision driver 2 (141 units/s); MOT-13 display modes
    assert rig.motion.eye_height == 3.7
    assert rig.motion.max_speed == 141
    assert dict(rig.backend) == {"mode": "spawn"}
    assert rig.to_dict()["motion"] == {"eyeHeight": 3.7, "maxSpeed": 141}


def test_display_mode_has_no_default(sim_rig_data, write_rig):
    """Absent, the motion core chooses the mode from the sample period (MOT-13); the paper's
    mode is open (D17), so the rig file does not decide it."""
    del sim_rig_data["motion"]
    rig = load_rig(write_rig(sim_rig_data))
    assert rig.motion.display_mode is None and rig.motion.display_delay_us is None
    assert "default" not in load_schema()["properties"]["motion"]["properties"]["displayMode"]


def test_given_values_override_defaults(sim_rig_data, write_rig):
    sim_rig_data["motion"] = {"eyeHeight": 2.1, "displayMode": "latest", "displayDelayUs": 0}
    rig = load_rig(write_rig(sim_rig_data))
    motion = rig.motion
    assert (motion.eye_height, motion.display_mode, motion.display_delay_us) == (2.1, "latest", 0)
    assert rig.motion.max_speed == 141


def test_no_speed_clamp_field(sim_rig_data, write_rig):
    """D10 (owner, 2026-10-09): no running-speed clamp, so the rig file has no field for one."""
    sim_rig_data["motion"]["speedClamp"] = 100
    with pytest.raises(RigFileError) as excinfo:
        load_rig(write_rig(sim_rig_data))
    assert pointers(excinfo) == ["/motion/speedClamp"]
    assert "unknown field" in messages(excinfo)["/motion/speedClamp"]
    max_speed = load_schema()["properties"]["motion"]["properties"]["maxSpeed"]
    assert "Not a clamp" in max_speed["description"]


def _set(data, path, value):
    *parents, last = path
    for key in parents:
        data = data[key]
    if value is DELETE:
        del data[last]
    else:
        data[last] = value


DELETE = object()

INVALID = [
    # (what is changed, value, pointer reported, part of the message)
    (["name"], DELETE, "/name", "missing"),
    (["format"], "rig", "/format", "was expected"),
    (["version"], 2, "/version", "was expected"),
    (["name"], "my rig", "/name", "does not match"),
    (["devices", "ball", "periodUs"], 0, "/devices/ball/periodUs", "less than the minimum"),
    (["devices", "ball", "periodUs"], "50000", "/devices/ball/periodUs", "is not of type 'integer'"),
    # jsonschema alone counts 50000.0 as an integer; a device would receive "50000.0"
    (["devices", "ball", "periodUs"], 50000.0, "/devices/ball/periodUs", "is not of type 'integer'"),
    (["devices", "valve", "outputs"], 1.0, "/devices/valve/outputs", "is not of type 'integer'"),
    (["version"], 1.0, "/version", "is not of type 'integer'"),
    (["devices", "ball", "port"], "COM9", "/devices/ball/port", "unknown field"),
    (["devices", "ball", "driver"], "teensy_ball", "/devices/ball/driver", "is not one of"),
    (["devices", "ball", "deviceId"], DELETE, "/devices/ball/deviceId", "missing"),
    (["devices", "Ball"], {"driver": "simulated", "deviceId": "x", "outputs": 1}, "/devices/Ball",
     "invalid name"),
    (["devices", "spare"], {"driver": "simulated", "deviceId": "spare"}, "/devices/spare",
     "needs periodUs"),
    (["bindings", "motion"], "wheel", "/bindings/motion", "no device named 'wheel'"),
    (["bindings", "motion"], "valve", "/bindings/motion", "cannot serve the motion role"),
    (["bindings", "reward"], "ball", "/bindings/reward", "cannot serve the reward role"),
    (["bindings", "motion"], DELETE, "/bindings/motion", "missing"),
    (["bindings", "lick"], "ball", "/bindings/lick", "unknown field"),
    (["calibration", "ball"], DELETE, "/calibration/ball", "needs its calibration"),
    (["calibration", "ball", "matrix"], [[0, 1, 0], [1, 0, 0]], "/calibration/ball/matrix",
     "too short"),
    (["calibration", "ball", "matrix"], [[0, 1, 0], [1, 0], [0, 0, 1]], "/calibration/ball/matrix",
     "rows have [3, 2, 3] columns"),
    (["calibration", "ball", "matrix"], [[0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]],
     "/calibration/ball/matrix", "has 4 columns, but device 'ball' has 3 sensor axes"),
    (["calibration", "ball", "matrix"], [[0, "k", 0], [1, 0, 0], [0, 0, 1]],
     "/calibration/ball/matrix/0/1", "is not of type 'number'"),
    (["calibration", "ghost"], {"matrix": [[1], [0], [0]]}, "/calibration/ghost", "no device named"),
    (["safety"], DELETE, "/safety/reward", "needs its safety envelope"),
    (["safety", "reward", "maxPulseMs"], DELETE, "/safety/reward/maxPulseMs", "missing"),
    (["safety", "reward", "maxPulseMs"], 0, "/safety/reward/maxPulseMs", "less than or equal to"),
    (["dataRoot"], "", "/dataRoot", "should be non-empty"),
    (["motion", "eyeHeight"], 0, "/motion/eyeHeight", "less than or equal to"),
    (["motion", "displayMode"], "fast", "/motion/displayMode", "is not one of"),
    (["motion", "displayDelayUs"], 1.5, "/motion/displayDelayUs", "is not of type 'integer'"),
    (["motion", "displayDelayUs"], 2000.0, "/motion/displayDelayUs", "is not of type 'integer'"),
    (["backend"], {"mode": "auto"}, "/backend/mode", "is not one of"),
    (["backend"], {"mode": "spawn", "command": []}, "/backend/command", "should be non-empty"),
]


@pytest.mark.parametrize("path, value, pointer, text", INVALID,
                         ids=["/".join(map(str, case[0])) + f"={case[1]!r}"[:30] for case in INVALID])
def test_invalid_field_reported_with_its_pointer(sim_rig_data, write_rig, path, value, pointer, text):
    _set(sim_rig_data, path, value)
    with pytest.raises(RigFileError) as excinfo:
        load_rig(write_rig(sim_rig_data))
    assert pointer in pointers(excinfo), excinfo.value
    assert text in messages(excinfo)[pointer], excinfo.value
    assert pointer in str(excinfo.value)


def test_every_schema_problem_is_reported_at_once(sim_rig_data, write_rig):
    sim_rig_data["devices"]["ball"]["periodUs"] = -1
    sim_rig_data["motion"]["eyeHeight"] = "high"
    del sim_rig_data["dataRoot"]
    with pytest.raises(RigFileError) as excinfo:
        load_rig(write_rig(sim_rig_data))
    assert pointers(excinfo) == ["/dataRoot", "/devices/ball/periodUs", "/motion/eyeHeight"]


def test_duplicate_key_reported(write_rig, sim_rig_path, tmp_path):
    text = sim_rig_path.read_text(encoding="utf-8")
    text = text.replace('"name": "sim",', '"name": "sim", "name": "sim2",')
    path = tmp_path / "dup.json"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(RigFileError) as excinfo:
        load_rig(path)
    assert pointers(excinfo) == ["/name"]
    assert "twice" in messages(excinfo)["/name"]


@pytest.mark.parametrize("text, part", [
    ("{\n  \"format\": \"three-maze-rig\",\n", "line 3"),
    ('{"version": NaN}', "NaN is not a JSON number"),
    ('{"motion": {"eyeHeight": 1e400}}', "1e400 is beyond the range of a number"),
    ("[]", "is not of type 'object'"),
])
def test_unreadable_file_reported(tmp_path, text, part):
    path = tmp_path / "bad.json"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(RigFileError) as excinfo:
        load_rig(path)
    assert excinfo.value.issues[0].pointer == ""
    assert part in excinfo.value.issues[0].message


def test_byte_order_mark_accepted_and_hashed(sim_rig_path, tmp_path):
    raw = b"\xef\xbb\xbf" + sim_rig_path.read_bytes()
    path = tmp_path / "bom.json"
    path.write_bytes(raw)
    rig = load_rig(path)
    assert rig.raw == raw and rig.sha256 == hashlib.sha256(raw).hexdigest()


def test_data_root_relative_to_the_rig_file(sim_rig_data, write_rig, tmp_path):
    sim_rig_data["dataRoot"] = "sessions"
    path = write_rig(sim_rig_data)
    assert load_rig(path).data_root == path.parent / "sessions"
    sim_rig_data["dataRoot"] = str(tmp_path / "abs")
    assert load_rig(write_rig(sim_rig_data)).data_root == tmp_path / "abs"


def test_reward_device_optional(sim_rig_data, write_rig):
    del sim_rig_data["bindings"]["reward"], sim_rig_data["safety"]
    rig = load_rig(write_rig(sim_rig_data))
    assert dict(rig.bindings) == {"motion": "ball"}
    assert rig.bound_devices() == ["ball"]  # the unbound valve is never opened


def test_result_is_read_only(sim_rig_path):
    rig = load_rig(sim_rig_path)
    with pytest.raises(TypeError):
        rig.data["name"] = "other"
    with pytest.raises(TypeError):
        rig.devices["ball"].config["periodUs"] = 1
    with pytest.raises(AttributeError):
        rig.calibration["ball"]["matrix"][0].append(1)
    assert json.loads(json.dumps(rig.to_dict()))["calibration"]["ball"]["matrix"][1][0] == 0.0349


def test_schema_is_valid_draft_2020_12():
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    jsonschema.Draft202012Validator.check_schema(schema)


def test_schema_lists_exactly_the_registered_drivers():
    assert load_schema()["$defs"]["device"]["properties"]["driver"]["enum"] == driver_names()
