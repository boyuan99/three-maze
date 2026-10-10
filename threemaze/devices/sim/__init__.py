"""The reference simulated device of device protocol v1 (plan item DPR-02): the model (model.py),
what it measures (motion.py), its framing (frame.py) and how it runs in real time (port.py).

The rig driver "simulated" (threemaze/devices/simulated.py) runs it in the runtime's process; the
end-to-end bench's simulated serial port runs it behind pyserial (test/e2e/sim, v1 mode).
"""
from .frame import crc8, frame, int32, unframe
from .model import Delivery, Fault, SimConfig, SimDevice, config_from_entry, config_problems
from .motion import MotionError
from .port import Pacer, SimPort

__all__ = ["Delivery", "Fault", "MotionError", "Pacer", "SimConfig", "SimDevice", "SimPort",
           "config_from_entry", "config_problems", "crc8", "frame", "int32", "unframe"]
