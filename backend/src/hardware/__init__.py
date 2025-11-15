"""
Hardware management module for three-maze backend

Provides classes for managing hardware components:
- Serial port communication
- Water delivery system
- Hardware lifecycle management
"""

from backend.src.hardware.hardware_base import HardwareBase, HardwareManager
from backend.src.hardware.serial_manager import SerialManager
from backend.src.hardware.water_delivery import WaterDelivery

__all__ = [
    'HardwareBase',
    'HardwareManager',
    'SerialManager',
    'WaterDelivery',
]
