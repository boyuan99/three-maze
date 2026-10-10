"""The end-to-end sim's legacy (v0.3) stream with a trajectory, and its device file (plan item
DPR-02, revisions B1 and B2): distinct non-zero x, y, theta and lick values in fields 7 to 10 that
hallway04's own parser reads back; the default stream unchanged; misconfiguration refused."""
import json
from types import SimpleNamespace

import pytest

from threemaze_sim import config, devicecfg
from threemaze_sim.teensy import legacy_line

SENSOR = {"cmPerCount": 0.0349, "radPerCount": 0.05}  # v0.3's mapping (hallway04_experiment.py:84, :288)
# At 20 Hz: x = 6.98 * 0.05 / 0.0349 = 10 counts, y = 11.168 * 0.05 / 0.0349 = 16,
# theta = (180 / pi deg/s = 1 rad/s) * 0.05 / 0.05 = 1
TRAJECTORY = {"kind": "segments", "segments": [
    {"durationS": 0.1, "forwardCmPerS": 11.168, "leftCmPerS": 6.98, "yawDegPerS": 57.29577951308232,
     "lick": 1},
    {"durationS": 0.1, "forwardCmPerS": -5.584, "leftCmPerS": -3.49}]}


def settings(tmp_path, device=None, **env):
    env = {"THREEMAZE_SIM_DIR": str(tmp_path / "sim"), **env}
    if device is not None:
        path = tmp_path / "device.json"
        path.write_text(json.dumps(device), encoding="utf-8")
        env["THREEMAZE_SIM_DEVICE"] = str(path)
    s = config.from_env(env)
    s.device = devicecfg.load(s)
    return s


def test_default_stream_is_unchanged():
    # v0.3's simulated running: k*P,0,c,P,0,c,P,0,c,0,0,0,k (test/e2e/sim/threemaze_sim/teensy.py)
    assert legacy_line(1, 50000, 0, 16, 0, 0) == "50000,0,16,50000,0,16,50000,0,16,0,0,0,1"


def test_no_device_file_means_default_motion(tmp_path):
    s = settings(tmp_path)
    assert s.device is None and devicecfg.legacy_motion(s, 50000) is None


def test_fields_7_to_10_parse_through_hallway04(tmp_path, experiment_class):
    s = settings(tmp_path, {"sensor": SENSOR, "trajectory": TRAJECTORY})
    motion = devicecfg.legacy_motion(s, 50000)
    parse = experiment_class("hallway04_experiment.py")._parse_serial_line
    rows = []
    for k in range(1, 9):
        (x, y, theta), lick = motion.next()
        parsed = parse(SimpleNamespace(experiment_id="test"), legacy_line(k, 50000, x, y, theta, lick))
        rows.append((parsed["x"], parsed["y"], parsed["theta"], parsed["water"], parsed["frameCount"]))
    run, back = (10.0, 16.0, 1.0, 1), (-5.0, -8.0, 0.0, 0)
    assert rows == [(*fields, k) for k, fields in enumerate([run, run, back, back] * 2, 1)]


def test_the_period_of_the_init_line_sets_the_counts(tmp_path):
    s = settings(tmp_path, {"sensor": SENSOR, "trajectory": TRAJECTORY})
    # 250 Hz: 0.8 lateral and 1.28 forward counts, 0.08 yaw counts in the first sample, rounded half up
    assert devicecfg.legacy_motion(s, 4000).next() == ((1, 1, 0), 1)


@pytest.mark.parametrize("device, env, text", [
    ({"sensor": SENSOR, "trajectory": TRAJECTORY, "periodUs": 4000}, {}, "periodUs not used by the legacy-v0.3"),
    ({"sensor": SENSOR, "trajectory": TRAJECTORY}, {"THREEMAZE_SIM_SPEED": "2"}, "THREEMAZE_SIM_SPEED applies"),
    ({"trajectory": TRAJECTORY}, {}, "/sensor: missing"),
    ({"sensor": SENSOR, "trajectory": {"kind": "replay", "file": "missing.tsv"}}, {}, "cannot read"),
    (None, {"THREEMAZE_SIM_PROTOCOL": "v1"}, "needs THREEMAZE_SIM_DEVICE"),
    ({"periodUs": 50000}, {"THREEMAZE_SIM_PROTOCOL": "v1"}, "/deviceId: missing"),
    ({"deviceId": "d", "driver": "serial"}, {"THREEMAZE_SIM_PROTOCOL": "v1"}, "driver must be 'simulated'"),
])
def test_misconfiguration_refused(tmp_path, device, env, text):
    """Refused when the sim activates; sitecustomize then exits with code 86 (fail closed)."""
    with pytest.raises(config.SimConfigError, match=text):
        settings(tmp_path, device, **env)


def test_v1_device_file_accepted(tmp_path):
    s = settings(tmp_path, {"deviceId": "sim-1", "periodUs": 4000, "outputs": 1}, THREEMAZE_SIM_PROTOCOL="v1")
    assert s.protocol == "v1" and devicecfg.v1_entry(s)["driver"] == "simulated"
