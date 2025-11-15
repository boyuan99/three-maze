"""
experiment_base.py

Abstract base class for Python-based experiments in three-maze.

Supports TWO hardware management modes:
1. MANAGED MODE: Backend manages hardware globally (simple, safe)
2. AUTONOMOUS MODE: Experiment manages its own hardware (ViRMEn-style, flexible)

Usage:
    1. Subclass ExperimentBase
    2. Set HARDWARE_MODE = 'managed' or 'autonomous'
    3. Implement initialize(), process_serial_data(), get_state(), terminate()
    4. Register experiment with backend server

Example (Managed):
    class SimpleExperiment(ExperimentBase):
        HARDWARE_MODE = 'managed'

        def __init__(self, experiment_id, config, hardware_manager):
            super().__init__(experiment_id, config, hardware_manager)

        async def initialize(self, config):
            # No hardware initialization needed
            return self.get_state()

Example (Autonomous):
    class ComplexExperiment(ExperimentBase):
        HARDWARE_MODE = 'autonomous'

        def __init__(self, experiment_id, config, hardware_manager=None):
            super().__init__(experiment_id, config, hardware_manager=None)

        async def initialize(self, config):
            # Initialize own hardware
            await self._init_serial_port('COM5', 115200)
            await self._init_water_delivery()
            self._open_data_file()
            return self.get_state()

        async def terminate(self):
            # Clean up own hardware
            await self._close_serial_port()
            await self._close_water_delivery()
            self._close_data_file()
            return {'numRewards': self.num_rewards}
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, Optional
import numpy as np
from datetime import datetime
import logging
import os

logger = logging.getLogger(__name__)


class ExperimentBase(ABC):
    """
    Abstract base class for Python-based experiments.

    Supports both managed and autonomous hardware management modes.

    Attributes:
        HARDWARE_MODE: 'managed' or 'autonomous' (set by subclass)
        hardware_manager: Backend hardware manager (managed mode only)
        experiment_id: Unique identifier for this experiment
        config: Experiment configuration dictionary
        start_time: Timestamp when experiment was initialized
        is_active: Boolean flag indicating if experiment is running
    """

    # Hardware management mode (override in subclass)
    HARDWARE_MODE = 'managed'  # 'managed' | 'autonomous'

    def __init__(self, experiment_id: str, config: Dict[str, Any], hardware_manager=None):
        """
        Initialize the experiment.

        Args:
            experiment_id: Unique string identifier for this experiment
            config: Configuration dictionary from frontend
            hardware_manager: Backend HardwareManager (managed mode only, can be None for autonomous)
        """
        self.experiment_id = experiment_id
        self.config = config

        # === MANAGED MODE ===
        # Backend provides hardware_manager
        self.hardware_manager = hardware_manager

        # === AUTONOMOUS MODE ===
        # Experiment owns these hardware instances
        self.serial = None
        self.water = None
        self.data_file = None

        # === COMMON STATE ===
        self.start_time = None
        self.is_active = False

        # Physics state
        self.position = np.array([0.0, 0.0, 0.5, 0.0])  # [x, y, z, theta]
        self.velocity = np.array([0.0, 0.0, 0.0, 0.0])  # [vx, vy, vz, vtheta]

        # Trial tracking
        self.trial_number = 0
        self.num_rewards = 0

        # World state (for dynamic objects - optional)
        self.world_objects = {}  # id -> object state
        self.events_queue = []   # Pending events to send

        logger.info(f"Experiment {experiment_id} created in {self.HARDWARE_MODE} mode")

    # =========================================================================
    # ABSTRACT METHODS (Must be implemented by subclasses)
    # =========================================================================

    @abstractmethod
    async def initialize(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Initialize experiment state and parameters.

        Called once when the experiment is registered with the backend.

        MANAGED MODE: No hardware initialization needed (backend manages it)
        AUTONOMOUS MODE: Initialize your own hardware here

        Args:
            config: Dictionary containing experiment configuration from frontend

        Returns:
            Dictionary containing initial state to send to frontend
        """
        pass

    @abstractmethod
    async def process_serial_data(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Process incoming serial data and update experiment state.

        Called automatically at ~60 Hz.

        MANAGED MODE: Data is provided by backend
        AUTONOMOUS MODE: Read from your own serial port

        Args:
            data: Dictionary with serial data (managed) or None (autonomous - read yourself)

        Returns:
            Dictionary containing updated state for frontend rendering,
            or None if no update should be sent
        """
        pass

    @abstractmethod
    def get_state(self) -> Dict[str, Any]:
        """
        Get current experiment state for frontend rendering.

        Returns:
            Dictionary containing current position, velocity, trial info, etc.

        Recommended structure:
            {
                'player': {'position': [...], 'velocity': [...]},
                'experiment': {'trialNumber': ..., 'numRewards': ...},
                'world': {'objects': [...]},  # Optional
                'events': [...]  # Optional
            }
        """
        pass

    @abstractmethod
    async def terminate(self) -> Dict[str, Any]:
        """
        Clean up experiment resources and finalize data.

        Called when experiment is stopped or scene is closed.

        MANAGED MODE: No hardware cleanup needed
        AUTONOMOUS MODE: Clean up your own hardware

        Returns:
            Dictionary containing final statistics or summary
        """
        pass

    # =========================================================================
    # AUTONOMOUS MODE: Hardware Management Methods
    # =========================================================================

    async def _init_serial_port(self, port: str, baudrate: int = 115200):
        """
        Initialize serial port (AUTONOMOUS MODE ONLY).

        Args:
            port: Serial port name (e.g., 'COM5', '/dev/ttyUSB0')
            baudrate: Baud rate (default: 115200)

        Raises:
            Exception: If called in managed mode or initialization fails
        """
        if self.HARDWARE_MODE != 'autonomous':
            raise Exception("_init_serial_port() only available in autonomous mode")

        from backend.src.hardware.serial_manager import SerialManager

        self.serial = SerialManager()

        success = await self.serial.initialize({
            'port': port,
            'baudRate': baudrate
        })

        if success:
            await self.serial.start()
            logger.info(f"[{self.experiment_id}] Serial port {port} initialized @ {baudrate} baud")
        else:
            error_msg = self.serial.last_error or "Unknown error"
            raise Exception(f"Failed to initialize serial port {port}: {error_msg}")

    async def _close_serial_port(self):
        """Close serial port (AUTONOMOUS MODE ONLY)."""
        if self.serial:
            await self.serial.cleanup()
            self.serial = None
            logger.info(f"[{self.experiment_id}] Serial port closed")

    async def _init_water_delivery(self, device: str = 'Dev1', channel: str = 'ao0'):
        """
        Initialize water delivery system (AUTONOMOUS MODE ONLY).

        Args:
            device: NI-DAQ device name (default: 'Dev1')
            channel: Analog output channel (default: 'ao0')

        Raises:
            Exception: If called in managed mode or initialization fails
        """
        if self.HARDWARE_MODE != 'autonomous':
            raise Exception("_init_water_delivery() only available in autonomous mode")

        from backend.src.hardware.water_delivery import WaterDelivery

        self.water = WaterDelivery()

        success = await self.water.initialize({
            'device': device,
            'channel': channel,
            'voltage': 5.0,
            'duration': 25,
            'cooldown': 1000
        })

        if success:
            await self.water.start()
            logger.info(f"[{self.experiment_id}] Water delivery initialized ({device}/{channel})")
        else:
            raise Exception("Failed to initialize water delivery")

    async def _close_water_delivery(self):
        """Close water delivery system (AUTONOMOUS MODE ONLY)."""
        if self.water:
            await self.water.cleanup()
            self.water = None
            logger.info(f"[{self.experiment_id}] Water delivery closed")

    def _open_data_file(self, directory: str = "logs", custom_header: Optional[str] = None):
        """
        Open data logging file (AUTONOMOUS MODE ONLY).

        Args:
            directory: Directory to save log files (default: 'logs')
            custom_header: Custom TSV header (default: auto-generated)

        Raises:
            Exception: If called in managed mode

        Returns:
            str: Full path to created log file
        """
        if self.HARDWARE_MODE != 'autonomous':
            raise Exception("_open_data_file() only available in autonomous mode")

        # Create logs directory if needed
        os.makedirs(directory, exist_ok=True)

        # Generate filename with timestamp
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        filename = f"{directory}/{self.experiment_id}-{timestamp}.tsv"

        self.data_file = open(filename, 'w')

        # Write header
        if custom_header:
            header = custom_header
        else:
            header = "timestamp\tx\ty\tz\ttheta\tvx\tvy\tvz\tvtheta\ttrial\treward\n"

        self.data_file.write(header)

        logger.info(f"[{self.experiment_id}] Data file opened: {filename}")
        return filename

    def _close_data_file(self):
        """Close data logging file (AUTONOMOUS MODE ONLY)."""
        if self.data_file:
            self.data_file.close()
            self.data_file = None
            logger.info(f"[{self.experiment_id}] Data file closed")

    def _log_data(self, **kwargs):
        """
        Write data entry to file (AUTONOMOUS MODE ONLY).

        Args:
            **kwargs: Key-value pairs to log (will be written in order)

        Example:
            self._log_data(x=self.position[0], y=self.position[1], reward=self.num_rewards)
        """
        if self.data_file:
            timestamp = datetime.now().timestamp()
            line = f"{timestamp}"

            # Add custom fields
            for value in kwargs.values():
                line += f"\t{value}"

            line += "\n"
            self.data_file.write(line)

    # =========================================================================
    # COMMON METHODS (Both Modes)
    # =========================================================================

    async def deliver_water(self, amount: int = 1, duration: int = 25) -> bool:
        """
        Deliver water reward (WORKS IN BOTH MODES).

        Automatically uses the correct method based on hardware mode:
        - Managed mode: Uses hardware_manager
        - Autonomous mode: Uses own water delivery

        Args:
            amount: Number of reward pulses
            duration: Duration of each pulse in milliseconds

        Returns:
            True if successful, False otherwise
        """
        try:
            if self.HARDWARE_MODE == 'managed':
                # === MANAGED MODE ===
                if not self.hardware_manager:
                    logger.error(f"[{self.experiment_id}] Hardware manager not available")
                    return False

                result = await self.hardware_manager.deliver_water(amount, duration)
                if result.get('success'):
                    self.num_rewards += amount
                    logger.debug(f"[{self.experiment_id}] Water delivered: {self.num_rewards} total (managed)")
                    return True
                return False

            else:  # autonomous
                # === AUTONOMOUS MODE ===
                if not self.water:
                    logger.error(f"[{self.experiment_id}] Water delivery not initialized")
                    return False

                result = await self.water.deliver(amount)
                if result.get('success'):
                    self.num_rewards += amount
                    logger.debug(f"[{self.experiment_id}] Water delivered: {self.num_rewards} total (autonomous)")
                    return True
                return False

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Water delivery failed: {e}")
            return False

    async def read_serial_data(self) -> Optional[Dict[str, Any]]:
        """
        Read latest serial data (AUTONOMOUS MODE ONLY).

        Returns:
            Dictionary with serial data, or None if not available
        """
        if self.HARDWARE_MODE != 'autonomous':
            logger.warning(f"[{self.experiment_id}] read_serial_data() only useful in autonomous mode")
            return None

        if self.serial and self.serial.is_active:
            return await self.serial.get_latest_data()
        return None

    async def _send_serial_command(self, command: str):
        """
        Send a command to the serial port (AUTONOMOUS MODE ONLY).

        Useful for initializing devices that require commands (like Teensy START/STOP).

        Args:
            command: Command string to send (should include newline if needed)
        """
        if self.HARDWARE_MODE != 'autonomous':
            raise Exception("_send_serial_command() only available in autonomous mode")

        if not self.serial or not self.serial.is_initialized:
            raise Exception("Serial port not initialized")

        try:
            # Access the underlying serial port (SerialManager stores it as self.port)
            if hasattr(self.serial, 'port') and self.serial.port and self.serial.port.is_open:
                self.serial.port.write(command.encode('utf-8'))
                self.serial.port.flush()
                logger.info(f"[{self.experiment_id}] Sent serial command: {command.strip()}")
            else:
                raise Exception("Serial port object not available or not open")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Failed to send serial command: {e}")
            raise

    def normalize_angle(self, theta: float) -> float:
        """
        Normalize angle to [-π, π] range.

        Args:
            theta: Angle in radians

        Returns:
            Normalized angle in range [-π, π]
        """
        while theta > np.pi:
            theta -= 2 * np.pi
        while theta < -np.pi:
            theta += 2 * np.pi
        return theta

    def get_elapsed_time(self) -> float:
        """
        Get elapsed time since experiment started.

        Returns:
            Time in seconds, or 0 if not started
        """
        if self.start_time is None:
            return 0.0
        return (datetime.now() - self.start_time).total_seconds()

    def reset_position(self, x: float = 0.0, y: float = 0.0, z: float = 0.5, theta: float = 0.0):
        """
        Reset player position to specified coordinates.

        Args:
            x: X coordinate (lateral)
            y: Y coordinate (forward/backward)
            z: Z coordinate (vertical)
            theta: Rotation angle in radians
        """
        self.position = np.array([x, y, z, theta])
        self.velocity = np.array([0.0, 0.0, 0.0, 0.0])

    # =========================================================================
    # WORLD STATE MANAGEMENT (Optional - for dynamic experiments)
    # =========================================================================

    def add_object(self, obj_id: str, obj_data: Dict[str, Any]):
        """
        Add or update a world object.

        Args:
            obj_id: Unique object identifier
            obj_data: Object state dictionary
                {
                    'id': 'object_id',
                    'type': 'sphere' | 'zone' | 'wall' | etc.,
                    'position': [x, y, z],
                    'color': [r, g, b],
                    'visible': True | False,
                    'scale': [sx, sy, sz]  # Optional
                }
        """
        self.world_objects[obj_id] = obj_data

    def update_object(self, obj_id: str, **kwargs):
        """
        Update object properties.

        Args:
            obj_id: Object identifier
            **kwargs: Properties to update
        """
        if obj_id in self.world_objects:
            self.world_objects[obj_id].update(kwargs)

    def set_object_color(self, obj_id: str, color: list):
        """Change object color."""
        self.update_object(obj_id, color=color)

    def set_object_visibility(self, obj_id: str, visible: bool):
        """Show/hide object."""
        self.update_object(obj_id, visible=visible)

    def set_object_position(self, obj_id: str, position: list):
        """Move object."""
        self.update_object(obj_id, position=position)

    def emit_event(self, event_type: str, **kwargs):
        """
        Queue an event to send to frontend.

        Args:
            event_type: Event type name
            **kwargs: Event data
        """
        event = {
            'type': event_type,
            'timestamp': datetime.now().timestamp(),
            **kwargs
        }
        self.events_queue.append(event)
