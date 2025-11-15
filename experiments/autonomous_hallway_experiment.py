"""
EXPERIMENT_ID: autonomous_hallway
EXPERIMENT_NAME: Autonomous Hallway Experiment
HARDWARE_MODE: autonomous

autonomous_hallway_experiment.py

Autonomous version of hallway experiment demonstrating AUTONOMOUS hardware mode.

This experiment is identical to HallwayExperiment in functionality, but manages
its own hardware resources (serial port, water delivery, data logging) instead of
using the backend's shared hardware manager.

This demonstrates the ViRMEn-style autonomous pattern where experiments have
complete control over their hardware lifecycle.

Hardware Mode: AUTONOMOUS
- Experiment owns and manages its own hardware instances
- Must initialize hardware in initialize()
- Must cleanup hardware in terminate()
- Full control over hardware configuration

Data Logging:
- Sampling rate: 20 Hz (automatically matches Teensy transmission rate)
- "One data point per Teensy transmission" approach - logs only when timestamp changes
- Backend may call process_serial_data() at higher frequency (~50Hz), but duplicate
  data is automatically skipped by comparing timestamps
- This ensures no data loss and no duplicate records

Usage:
    Register with backend server:
    experiment = AutonomousHallwayExperiment("autonomous_hallway", config)
    await experiment.initialize(config)

    Config should include:
    {
        'port': 'COM6',          # Serial port
        'baudRate': 115200,      # Baud rate
        'daqDevice': 'Dev1',     # NI-DAQ device
        'daqChannel': 'ao0',     # Water delivery channel
        'trialEndY': 70.0        # Trial end position
    }
"""

from typing import Dict, Any, Optional
import numpy as np
from datetime import datetime
from backend.src.experiment_base import ExperimentBase
import logging

logger = logging.getLogger(__name__)


class AutonomousHallwayExperiment(ExperimentBase):
    """
    Autonomous hallway experiment with self-managed hardware.

    This experiment demonstrates the AUTONOMOUS mode pattern where the experiment
    owns and controls its own hardware resources, similar to ViRMEn MATLAB experiments.

    Hardware Mode: AUTONOMOUS
    - Owns serial port connection
    - Owns water delivery system
    - Owns data logging file
    - Must initialize and cleanup all hardware
    """

    # Declare autonomous mode (experiment manages own hardware)
    HARDWARE_MODE = 'autonomous'

    def __init__(self, experiment_id: str, config: Dict[str, Any], hardware_manager=None):
        """
        Initialize autonomous hallway experiment.

        Args:
            experiment_id: Unique identifier (e.g., "autonomous_hallway")
            config: Configuration dictionary from frontend
            hardware_manager: Not used in autonomous mode (always None)
        """
        super().__init__(experiment_id, config, hardware_manager=None)

        # Hallway dimensions (matching Hallway02.json)
        self.HALLWAY_LENGTH = 200.0  # Total length: 140 + 30 + 30
        self.HALLWAY_WIDTH = 40.0
        self.WALL_HEIGHT = 10.0
        self.BLUE_SEGMENT_LENGTH = 30.0

        # Physics parameters
        self.PLAYER_RADIUS = 0.5
        self.MAX_LINEAR_VELOCITY = 100.0  # units per second
        self.DT = 1.0 / 20.0  # 20Hz sampling rate

        # Conversion factors
        self.ENCODER_TO_CM = 0.0364
        self.ROTATION_SENSITIVITY = 0.05

        # Trial parameters
        self.TRIAL_END_Y = 70.0  # Trial ends at ±70
        self.FALL_RESET_TIME = 5000  # 5 seconds

        # State tracking
        self.fall_start_time = None
        self.is_falling = False
        self.is_trial_start = True
        self.is_trial_end = False

        # Data logging control (only log NEW data, not duplicates)
        self.last_logged_serial_timestamp = None  # Track Teensy timestamp of last logged data

        # Data file management (autonomous - no dependency on backend)
        self.data_file = None
        self.data_file_path = None

        # DEBUG: Track first serial data processing
        self._first_serial_data_processed = False
        self._duplicate_count = 0  # Track how many duplicates we skip

    async def initialize(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Initialize experiment and its own hardware.

        This is where autonomous experiments initialize their hardware resources,
        similar to the initialization phase in ViRMEn experiments.

        Args:
            config: Configuration dictionary with hardware settings
                Required keys:
                - port: Serial port name (e.g., 'COM6')
                - baudRate: Baud rate (e.g., 115200)
                Optional keys:
                - daqDevice: NI-DAQ device (default: 'Dev1')
                - daqChannel: Water channel (default: 'ao0')
                - trialEndY: Trial end position (default: 70.0)

        Returns:
            Initial state dictionary for frontend
        """
        logger.info(f"[{self.experiment_id}] ========== INITIALIZE START ==========")
        logger.info(f"[{self.experiment_id}] Initializing autonomous experiment")

        # === HARDWARE INITIALIZATION (Autonomous Mode) ===

        # 1. Initialize serial port (experiment owns)
        port = config.get('port', 'COM6')
        baudrate = config.get('baudRate', 115200)

        try:
            await self._init_serial_port(port, baudrate)
            logger.info(f"[{self.experiment_id}] Serial port initialized: {port} @ {baudrate} baud")

            # Send START command to Teensy to begin data acquisition
            # Format: START,<interval_ms>,<duration_s>
            # Use 50ms interval (20Hz), continuous mode (0 seconds)
            start_command = "START,50,0\n"
            logger.info(f"[{self.experiment_id}] Sending START command to Teensy: {start_command.strip()}")
            await self._send_serial_command(start_command)

            # Wait for Teensy to acknowledge and start sending data
            import asyncio
            await asyncio.sleep(0.5)  # Give Teensy time to initialize
            logger.info(f"[{self.experiment_id}] Teensy acquisition started")

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Failed to initialize serial port: {e}")
            raise

        # 2. Initialize water delivery (experiment owns)
        daq_device = config.get('daqDevice', 'Dev1')
        daq_channel = config.get('daqChannel', 'ao0')

        try:
            await self._init_water_delivery(daq_device, daq_channel)
            logger.info(f"[{self.experiment_id}] Water delivery initialized: {daq_device}/{daq_channel}")
        except Exception as e:
            logger.warning(f"[{self.experiment_id}] Water delivery not available: {e}")
            logger.warning(f"[{self.experiment_id}] Continuing without water delivery (no rewards will be delivered)")
            self.water = None  # Explicitly set to None to disable water delivery

        # 3. Open data file (experiment owns - fully autonomous implementation)
        try:
            self._open_autonomous_data_file()
            logger.info(f"[{self.experiment_id}] Data file opened: {self.data_file_path}")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Failed to open data file: {e}")
            # Cleanup hardware before raising
            await self._close_serial_port()
            await self._close_water_delivery()
            raise

        # === EXPERIMENT INITIALIZATION ===

        # Allow config to override default parameters
        self.TRIAL_END_Y = config.get('trialEndY', self.TRIAL_END_Y)
        self.PLAYER_RADIUS = config.get('playerRadius', self.PLAYER_RADIUS)
        self.MAX_LINEAR_VELOCITY = config.get('maxVelocity', self.MAX_LINEAR_VELOCITY)

        # DEBUG: Log position BEFORE reset
        logger.info(f"[{self.experiment_id}] Position BEFORE reset: {self.position}")

        # Initialize position and state (ALWAYS reset to origin)
        self.position = np.array([0.0, 0.0, self.PLAYER_RADIUS, 0.0])  # [x, y, z, theta]
        self.velocity = np.array([0.0, 0.0, 0.0, 0.0])
        self.trial_number = 0
        self.num_rewards = 0
        self.is_active = True
        self.start_time = datetime.now()

        # Reset trial flags
        self.is_trial_start = True
        self.is_trial_end = False
        self.fall_start_time = None
        self.is_falling = False

        # Reset data logging control
        self.last_logged_serial_timestamp = None
        self._duplicate_count = 0

        # DEBUG: Log position AFTER reset
        logger.info(f"[{self.experiment_id}] Position AFTER reset: {self.position}")
        logger.info(f"[{self.experiment_id}] Experiment initialized successfully")
        logger.info(f"[{self.experiment_id}] Trial end at Y = ±{self.TRIAL_END_Y}")

        # DEBUG: Read and log first few frames of serial data
        logger.info(f"[{self.experiment_id}] Checking initial serial data stream...")
        import asyncio
        for i in range(3):
            test_data = await self.read_serial_data()
            if test_data:
                logger.info(f"[{self.experiment_id}] Initial frame {i+1}: x={test_data.get('x', 0):.2f}, y={test_data.get('y', 0):.2f}, theta={test_data.get('theta', 0):.3f}")
                if 'totalA' in test_data:
                    logger.info(f"[{self.experiment_id}]   totalA: x={test_data['totalA']['x']:.1f}, y={test_data['totalA']['y']:.1f}")
                if 'totalB' in test_data:
                    logger.info(f"[{self.experiment_id}]   totalB: x={test_data['totalB']['x']:.1f}, y={test_data['totalB']['y']:.1f}")
            await asyncio.sleep(0.02)
        logger.info(f"[{self.experiment_id}] ========== INITIALIZE COMPLETE ==========")

        return self.get_state()

    async def process_serial_data(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Process trackball input and update experiment state.

        In AUTONOMOUS mode, the data parameter is None and the experiment
        must read from its own serial port.

        Called automatically by backend at high frequency (~50Hz), but data logging
        uses a "one data point per Teensy transmission" approach:
        - Only logs when timestamp changes (new data from Teensy)
        - Automatically skips duplicate/repeated data readings
        - Logging rate naturally matches Teensy transmission rate (20Hz)

        This ensures no data loss and no duplicate records.

        Args:
            data: None (autonomous mode reads own serial)

        Returns:
            Updated state dict for frontend, or None if no update
        """
        if not self.is_active:
            return None

        # === READ FROM OWN SERIAL PORT (Autonomous Mode) ===
        serial_data = await self.read_serial_data()

        if serial_data is None:
            return None  # No data available

        # DEBUG: Log first serial data received during runtime
        if not self._first_serial_data_processed:
            self._first_serial_data_processed = True
            logger.info(f"[{self.experiment_id}] ========== FIRST SERIAL DATA IN RUNTIME ==========")
            logger.info(f"[{self.experiment_id}] Serial data: x={serial_data.get('x', 0):.2f}, y={serial_data.get('y', 0):.2f}, theta={serial_data.get('theta', 0):.3f}")
            logger.info(f"[{self.experiment_id}] Teensy timestamp: {serial_data.get('timestamp')}")
            if 'totalA' in serial_data:
                logger.info(f"[{self.experiment_id}]   totalA: x={serial_data['totalA']['x']:.1f}, y={serial_data['totalA']['y']:.1f}")
            if 'totalB' in serial_data:
                logger.info(f"[{self.experiment_id}]   totalB: x={serial_data['totalB']['x']:.1f}, y={serial_data['totalB']['y']:.1f}")
            logger.info(f"[{self.experiment_id}] Current position BEFORE processing: {self.position}")

        # Process trackball input (only if not falling)
        if not self.is_falling:
            self._update_position_from_serial(serial_data)

        # DEBUG: Log position after first update
        if self._first_serial_data_processed and self.trial_number == 0:
            if not hasattr(self, '_first_position_logged'):
                self._first_position_logged = True
                logger.info(f"[{self.experiment_id}] Current position AFTER first processing: {self.position}")
                logger.info(f"[{self.experiment_id}] ===============================================")

        # Check for fall condition
        self._check_fall_condition()

        # Check for trial end condition
        if abs(self.position[1]) >= self.TRIAL_END_Y:
            await self._handle_trial_end()

        # Log data to own file (only log NEW data - one data point per Teensy transmission)
        # Check if this is new data by comparing Teensy's timestamp with last logged one
        current_serial_timestamp = serial_data.get('timestamp')  # Teensy's Time(us) field

        if current_serial_timestamp != self.last_logged_serial_timestamp:
            # This is NEW data from Teensy - log it!
            self._log_autonomous_data()
            self.last_logged_serial_timestamp = current_serial_timestamp

            # DEBUG: Log if we skipped duplicates
            if self._duplicate_count > 0:
                logger.debug(f"[{self.experiment_id}] Skipped {self._duplicate_count} duplicate readings before logging new data")
                self._duplicate_count = 0
        else:
            # This is duplicate data (already processed) - skip logging
            self._duplicate_count += 1

        # Return updated state for frontend rendering
        return self.get_state()

    def _update_position_from_serial(self, data: Dict[str, Any]):
        """
        Convert serial data to position/velocity updates.

        Args:
            data: Dictionary with 'x', 'y', 'theta' from trackball
        """
        try:
            # Extract and convert encoder counts to cm/s velocity
            raw_x = float(data.get('x', 0))
            raw_y = float(data.get('y', 0))

            vx = np.clip(
                raw_x * self.ENCODER_TO_CM / self.DT,
                -self.MAX_LINEAR_VELOCITY,
                self.MAX_LINEAR_VELOCITY
            )
            vy = np.clip(
                raw_y * self.ENCODER_TO_CM / self.DT,
                -self.MAX_LINEAR_VELOCITY,
                self.MAX_LINEAR_VELOCITY
            )

            # Transform velocities from trackball frame to world frame
            theta = self.position[3]
            world_vx = vx * np.cos(theta) - vy * np.sin(theta)
            world_vz = -vx * np.sin(theta) - vy * np.cos(theta)

            # Update velocity vector
            self.velocity[0] = world_vx
            self.velocity[1] = world_vz
            self.velocity[2] = 0.0

            # Update position using Euler integration
            self.position[0] += self.velocity[0] * self.DT
            self.position[1] += self.velocity[1] * self.DT

            # Handle rotation
            raw_theta = float(data.get('theta', 0))
            delta_theta = raw_theta * self.ROTATION_SENSITIVITY
            self.position[3] += delta_theta

            # Normalize theta to [-π, π]
            self.position[3] = self.normalize_angle(self.position[3])

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error processing serial data: {e}")

    def _check_fall_condition(self):
        """
        Check if player has fallen off the platform.
        """
        current_z = self.position[2]

        if current_z < self.PLAYER_RADIUS and self.fall_start_time is None:
            # Started falling
            self.fall_start_time = datetime.now()
            self.is_falling = True
            logger.debug(f"[{self.experiment_id}] Player falling...")
        elif current_z >= self.PLAYER_RADIUS:
            # Back on solid ground
            self.fall_start_time = None
            self.is_falling = False

        # Check if we've been falling too long
        if self.fall_start_time is not None:
            fall_duration = (datetime.now() - self.fall_start_time).total_seconds() * 1000
            if fall_duration > self.FALL_RESET_TIME:
                logger.debug(f"[{self.experiment_id}] Fall timeout - resetting player")
                self._reset_player()

    async def _handle_trial_end(self):
        """
        Handle trial completion: deliver reward and reset position.
        """
        if self.is_trial_end:
            return  # Already handling trial end

        self.is_trial_end = True
        self.trial_number += 1

        logger.info(f"[{self.experiment_id}] Trial {self.trial_number} completed at Y = {self.position[1]:.2f}")

        # Deliver water using OWN water delivery system (autonomous mode)
        success = await self.deliver_water(amount=1, duration=25)
        if success:
            logger.info(f"[{self.experiment_id}] Reward {self.num_rewards} delivered")
        else:
            logger.warning(f"[{self.experiment_id}] Water delivery failed")

        # Reset player
        self._reset_player()
        self.is_trial_end = False
        self.is_trial_start = True

    def _reset_player(self):
        """Reset player to starting position."""
        logger.debug(f"[{self.experiment_id}] Resetting player to start position")
        self.reset_position(0.0, 0.0, self.PLAYER_RADIUS, 0.0)
        self.fall_start_time = None
        self.is_falling = False

    def get_state(self) -> Dict[str, Any]:
        """
        Get current experiment state for frontend rendering.

        Returns:
            Dictionary containing all state variables needed by frontend
        """
        return {
            'player': {
                'position': self.position.tolist(),
                'velocity': self.velocity.tolist()
            },
            'experiment': {
                'trialNumber': self.trial_number,
                'numRewards': self.num_rewards,
                'isActive': self.is_active,
                'isFalling': self.is_falling,
                'isTrialStart': self.is_trial_start,
                'isTrialEnd': self.is_trial_end,
                'elapsedTime': self.get_elapsed_time()
            },
            'serial_connected': self.serial is not None and self.serial.is_active,
            'serial_port': self.serial.port_name if self.serial else None,
            'serial_data_rate': self.serial.data_rate if self.serial else 0.0,
            'state': 'running' if self.is_active else 'stopped'
        }

    async def terminate(self) -> Dict[str, Any]:
        """
        Clean up experiment and its own hardware.

        This is where autonomous experiments cleanup their hardware resources,
        similar to the termination phase in ViRMEn experiments.

        Returns:
            Summary statistics dictionary
        """
        logger.info(f"[{self.experiment_id}] ========== STARTING CLEANUP ==========")
        logger.info(f"[{self.experiment_id}] Final position: {self.position}")
        logger.info(f"[{self.experiment_id}] Total trials: {self.trial_number}")
        logger.info(f"[{self.experiment_id}] Total rewards: {self.num_rewards}")
        logger.info(f"[{self.experiment_id}] EXPERIMENT TERMINATED")

        # === HARDWARE CLEANUP (Autonomous Mode) ===

        # 1. Stop Teensy acquisition and close serial port (experiment owns)
        try:
            # Send STOP command to Teensy
            logger.info(f"[{self.experiment_id}] Sending STOP command to Teensy")
            await self._send_serial_command("STOP\n")

            # Give Teensy time to stop gracefully
            import asyncio
            await asyncio.sleep(0.2)

            # Close serial port
            await self._close_serial_port()
            logger.info(f"[{self.experiment_id}] Serial port closed")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error closing serial port: {e}")

        # 2. Close water delivery (experiment owns)
        try:
            await self._close_water_delivery()
            logger.info(f"[{self.experiment_id}] Water delivery closed")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error closing water delivery: {e}")

        # 3. Close data file (experiment owns - fully autonomous implementation)
        try:
            self._close_autonomous_data_file()
            logger.info(f"[{self.experiment_id}] Data file closed")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error closing data file: {e}")

        # === EXPERIMENT FINALIZATION ===

        elapsed = self.get_elapsed_time()
        logger.info(f"[{self.experiment_id}] Total trials completed: {self.trial_number}")
        logger.info(f"[{self.experiment_id}] Total rewards delivered: {self.num_rewards}")
        logger.info(f"[{self.experiment_id}] Total duration: {elapsed:.1f} seconds")

        self.is_active = False

        return {
            'trialNumber': self.trial_number,
            'numRewards': self.num_rewards,
            'elapsedTime': elapsed,
            'rewardRate': self.num_rewards / elapsed if elapsed > 0 else 0
        }

    # =========================================================================
    # FULLY AUTONOMOUS DATA LOGGING (No Backend Dependency)
    # =========================================================================

    def _open_autonomous_data_file(self):
        """
        Open data logging file (fully autonomous - no backend dependency).

        Creates a TSV file in the logs/ directory with timestamp-based filename.
        Writes a standard header for the data columns.

        Raises:
            Exception: If file creation fails
        """
        import os

        # Create logs directory if it doesn't exist
        os.makedirs("logs", exist_ok=True)

        # Generate filename with timestamp
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.data_file_path = f"logs/{self.experiment_id}-{timestamp}.tsv"

        # Open file for writing
        self.data_file = open(self.data_file_path, 'w')

        # Write TSV header
        header = "timestamp\tx\ty\tz\ttheta\tvx\tvy\tvz\tvtheta\ttrial\treward\n"
        self.data_file.write(header)

        logger.info(f"[{self.experiment_id}] Data file created: {self.data_file_path}")

    def _log_autonomous_data(self):
        """
        Write current experiment state to data file (fully autonomous - no backend dependency).

        Logs a single line containing current timestamp, position, velocity, trial number,
        and reward count. Flushes immediately to ensure data is written to disk.

        Format: TSV with columns matching the header written in _open_autonomous_data_file()
        """
        if self.data_file:
            # Get current timestamp
            timestamp = datetime.now().timestamp()

            # Format data line (tab-separated)
            line = (
                f"{timestamp}\t"
                f"{self.position[0]}\t{self.position[1]}\t{self.position[2]}\t{self.position[3]}\t"
                f"{self.velocity[0]}\t{self.velocity[1]}\t{self.velocity[2]}\t{self.velocity[3]}\t"
                f"{self.trial_number}\t{self.num_rewards}\n"
            )

            # Write and flush immediately
            self.data_file.write(line)
            self.data_file.flush()

    def _close_autonomous_data_file(self):
        """
        Close data logging file (fully autonomous - no backend dependency).

        Safely closes the file handle and clears the file reference.
        """
        if self.data_file:
            self.data_file.close()
            self.data_file = None
            logger.info(f"[{self.experiment_id}] Data file closed: {self.data_file_path}")
