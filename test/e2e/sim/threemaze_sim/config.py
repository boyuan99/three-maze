"""Settings of the simulated rig, read once from the environment when the sim activates."""
import math
import os

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
SIM_ROOT = os.path.dirname(PACKAGE_DIR)          # the directory that has to be on PYTHONPATH


def default_sim_dir():
    """Used only when THREEMAZE_SIM_DIR is not set: never inside the repository."""
    import tempfile
    return os.path.join(tempfile.gettempdir(), "three-maze-sim")

# --- Teensy protocol (hallway01/02/04 firmware, 13-field CSV) -----------------------------------
DEFAULT_PERIOD_MS = 50           # used when the init string carries no usable period
FORWARD_COUNTS_PER_SAMPLE = 16   # forward ball counts per sample at THREEMAZE_SIM_SPEED=1
LINE_ENDING = b"\r\n"            # Teensy Serial.println()
INPUT_BUFFER_LIMIT = 1 << 20     # bytes the port buffers before new lines are dropped

SERIAL_MODES = ("ok", "missing", "busy", "silent")
DAQ_MODES = ("ok", "missing")
DATA_MODES = ("ok", "missing")


class SimConfigError(Exception):
    """A THREEMAZE_SIM_* variable has an invalid value."""


class Settings:
    def __init__(self, sim_dir, speed, serial_mode, daq_mode, data_mode, open_delay_s=0.0):
        self.sim_dir = sim_dir
        self.speed = speed
        self.serial_mode = serial_mode
        self.daq_mode = daq_mode
        self.data_mode = data_mode
        self.open_delay_s = open_delay_s
        self.virmen_dir = os.path.join(sim_dir, "VirmenData")
        self.serial_log = os.path.join(sim_dir, "serial.jsonl")
        self.daq_log = os.path.join(sim_dir, "daq.jsonl")
        self.sim_log = os.path.join(sim_dir, "sim.jsonl")
        self.port_lock_dir = os.path.join(sim_dir, "ports")

    def as_dict(self):
        return {
            "sim_dir": self.sim_dir,
            "speed": self.speed,
            "serial_mode": self.serial_mode,
            "daq_mode": self.daq_mode,
            "data_mode": self.data_mode,
            "open_delay_s": self.open_delay_s,
            "virmen_dir": self.virmen_dir,
            "forward_counts_per_sample": FORWARD_COUNTS_PER_SAMPLE * self.speed,
            "default_period_ms": DEFAULT_PERIOD_MS,
        }


def _choice(env, name, choices):
    value = (env.get(name) or choices[0]).strip().lower()
    if value not in choices:
        raise SimConfigError(f"{name}={env.get(name)!r}: expected one of {', '.join(choices)}")
    return value


def from_env(env=None):
    env = os.environ if env is None else env
    sim_dir = env.get("THREEMAZE_SIM_DIR") or default_sim_dir()
    sim_dir = os.path.normpath(os.path.abspath(sim_dir))
    if os.path.splitdrive(sim_dir)[0].upper() == "D:":
        raise SimConfigError(f"THREEMAZE_SIM_DIR={sim_dir!r} is on D:, which the sim redirects")

    raw_speed = env.get("THREEMAZE_SIM_SPEED", "1")
    try:
        speed = float(raw_speed)
    except ValueError:
        raise SimConfigError(f"THREEMAZE_SIM_SPEED={raw_speed!r} is not a number") from None
    if not math.isfinite(speed):
        raise SimConfigError(f"THREEMAZE_SIM_SPEED={raw_speed!r} is not finite")

    raw_delay = env.get("THREEMAZE_SIM_OPEN_DELAY_S", "0")
    try:
        open_delay_s = float(raw_delay)
    except ValueError:
        raise SimConfigError(f"THREEMAZE_SIM_OPEN_DELAY_S={raw_delay!r} is not a number") from None
    if not (math.isfinite(open_delay_s) and 0 <= open_delay_s <= 600):
        raise SimConfigError(f"THREEMAZE_SIM_OPEN_DELAY_S={raw_delay!r}: expected 0..600 seconds")

    return Settings(
        sim_dir=sim_dir,
        speed=speed,
        serial_mode=_choice(env, "THREEMAZE_SIM_SERIAL", SERIAL_MODES),
        daq_mode=_choice(env, "THREEMAZE_SIM_DAQ", DAQ_MODES),
        data_mode=_choice(env, "THREEMAZE_SIM_DATA", DATA_MODES),
        open_delay_s=open_delay_s,
    )
