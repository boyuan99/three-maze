"""
EXPERIMENT_ID: standalone_hallway
EXPERIMENT_NAME: Standalone Hallway Experiment
HARDWARE_MODE: standalone

standalone_hallway_experiment.py

Standalone experiment demonstrating complete independence from backend infrastructure.

This experiment shows a pure, self-contained approach where the user has direct
control over all hardware initialization and management. No inheritance from base
classes - all functionality implemented directly.

This pattern is ideal for users who:
- Want complete control over hardware implementation
- Need custom hardware interfaces not provided by the backend
- Prefer explicit code over abstraction layers
- Want to understand exactly what's happening at every step

Hardware Management: Direct
- User directly initializes pyserial for serial communication
- User directly initializes nidaqmx for DAQ control
- User directly manages file I/O for data logging
- No abstraction layers or helper methods

Data Logging:
- Sampling rate: 20 Hz (matches Teensy transmission rate)
- "One data point per transmission" - logs only when timestamp changes
- Duplicate data automatically skipped by comparing timestamps
- Ensures no data loss and no duplicate records

Usage:
    Register with backend server:
    experiment = StandaloneHallwayExperiment("standalone_hallway", config)
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
import asyncio
import logging

logger = logging.getLogger(__name__)


class Experiment:
    """
    Standalone hallway experiment with direct hardware control.

    This experiment demonstrates a pure, self-contained approach with no
    inheritance from base classes. All hardware is initialized and managed
    directly by the user code.

    Hardware Mode: STANDALONE
    - User directly initializes all hardware
    - User directly manages all resources
    - No dependency on backend infrastructure
    - Complete transparency and control
    """

    # Declare standalone mode
    HARDWARE_MODE = 'standalone'

    def __init__(self, experiment_id: str, config: Dict[str, Any], hardware_manager=None):
        """
        Initialize standalone hallway experiment.

        Args:
            experiment_id: Unique identifier (e.g., "standalone_hallway")
            config: Configuration dictionary from frontend
            hardware_manager: Not used in standalone mode (always None)
        """
        self.experiment_id = experiment_id
        self.config = config

        # Hallway dimensions
        self.HALLWAY_LENGTH = 200.0
        self.HALLWAY_WIDTH = 40.0
        self.WALL_HEIGHT = 10.0
        self.BLUE_SEGMENT_LENGTH = 30.0

        # Physics parameters
        self.PLAYER_RADIUS = 0.5
        self.MAX_LINEAR_VELOCITY = 100.0
        self.DT = 1.0 / 20.0  # 20Hz

        # Conversion factors
        self.ENCODER_TO_CM = 0.0364
        self.ROTATION_SENSITIVITY = 0.05

        # Trial parameters
        self.TRIAL_END_Y = 70.0
        self.FALL_RESET_TIME = 5000

        # State tracking
        self.position = np.array([0.0, 0.0, self.PLAYER_RADIUS, 0.0])
        # velocity[2] (vertical) = None means "use physics engine" (default)
        # velocity[2] = number means "backend controls vertical velocity"
        self.velocity = [0.0, 0.0, None, 0.0]
        self.trial_number = 0
        self.num_rewards = 0
        self.is_active = False
        self.start_time = None

        self.fall_start_time = None
        self.is_falling = False
        self.is_trial_start = True
        self.is_trial_end = False

        # Hardware resources (initialized in initialize())
        self.serial_port = None
        self.daq_task = None
        self.data_file = None
        self.data_file_path = None
        self.serial_read_task = None
        self.serial_buffer = []

        # Data logging control
        self.last_logged_serial_timestamp = None
        self._duplicate_count = 0

    async def initialize(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Initialize experiment with direct hardware setup.

        User directly initializes all hardware in this method:
        1. Serial port (pyserial)
        2. DAQ device (nidaqmx)
        3. Data file (standard Python file I/O)

        Args:
            config: Configuration dictionary with hardware settings

        Returns:
            Initial state dictionary for frontend
        """
        logger.info(f"[{self.experiment_id}] ========== INITIALIZE START ==========")

        # Override default parameters from config
        self.TRIAL_END_Y = config.get('trialEndY', self.TRIAL_END_Y)
        self.PLAYER_RADIUS = config.get('playerRadius', self.PLAYER_RADIUS)
        self.MAX_LINEAR_VELOCITY = config.get('maxVelocity', self.MAX_LINEAR_VELOCITY)

        # === 1. INITIALIZE SERIAL PORT (Direct pyserial) ===
        try:
            import serial

            port = config.get('port', 'COM6')
            baudrate = config.get('baudRate', 115200)

            self.serial_port = serial.Serial(
                port=port,
                baudrate=baudrate,
                timeout=0.001,  # Non-blocking reads
                write_timeout=1.0
            )

            logger.info(f"[{self.experiment_id}] Serial port opened: {port} @ {baudrate} baud")

            # Start background task to read serial data
            self.serial_read_task = asyncio.create_task(self._serial_read_loop())

            # Send START command to Teensy
            start_command = "START,50,0\n"
            self.serial_port.write(start_command.encode('utf-8'))
            logger.info(f"[{self.experiment_id}] START command sent to Teensy")

            await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Failed to initialize serial port: {e}")
            raise

        # === 2. INITIALIZE WATER DELIVERY (Direct nidaqmx) ===
        try:
            import nidaqmx
            from nidaqmx.constants import VoltageUnits

            daq_device = config.get('daqDevice', 'Dev1')
            daq_channel = config.get('daqChannel', 'ao0')

            self.daq_task = nidaqmx.Task()
            self.daq_task.ao_channels.add_ao_voltage_chan(
                f"{daq_device}/{daq_channel}",
                min_val=0.0,
                max_val=5.0,
                units=VoltageUnits.VOLTS
            )

            logger.info(f"[{self.experiment_id}] DAQ initialized: {daq_device}/{daq_channel}")

        except Exception as e:
            logger.warning(f"[{self.experiment_id}] DAQ not available: {e}")
            self.daq_task = None

        # === 3. OPEN DATA FILE (Direct file I/O) ===
        try:
            import os

            os.makedirs("logs", exist_ok=True)
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            self.data_file_path = f"logs/{self.experiment_id}-{timestamp}.tsv"

            self.data_file = open(self.data_file_path, 'w')
            header = "timestamp\tx\ty\tz\ttheta\tvx\tvy\tvz\tvtheta\ttrial\treward\n"
            self.data_file.write(header)

            logger.info(f"[{self.experiment_id}] Data file opened: {self.data_file_path}")

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Failed to open data file: {e}")
            # Cleanup
            if self.serial_port:
                self.serial_port.close()
            if self.daq_task:
                self.daq_task.close()
            raise

        # === 4. INITIALIZE EXPERIMENT STATE ===
        self.position = np.array([0.0, 0.0, self.PLAYER_RADIUS, 0.0])
        # velocity[2] (vertical) = None means "use physics engine" (default)
        self.velocity = [0.0, 0.0, None, 0.0]  # Use list to support None values
        self.trial_number = 0
        self.num_rewards = 0
        self.is_active = True
        self.start_time = datetime.now()

        self.is_trial_start = True
        self.is_trial_end = False
        self.fall_start_time = None
        self.is_falling = False

        self.last_logged_serial_timestamp = None
        self._duplicate_count = 0

        logger.info(f"[{self.experiment_id}] Initialization complete")
        logger.info(f"[{self.experiment_id}] Trial end at Y = ±{self.TRIAL_END_Y}")
        logger.info(f"[{self.experiment_id}] ========== INITIALIZE COMPLETE ==========")

        return self.get_state()

    async def _serial_read_loop(self):
        """Background task to read serial data continuously."""
        while self.serial_port and self.serial_port.is_open:
            try:
                if self.serial_port.in_waiting > 0:
                    line = self.serial_port.readline().decode('utf-8').strip()
                    if line:
                        # Parse and buffer the data
                        parsed = self._parse_serial_line(line)
                        if parsed:
                            self.serial_buffer.append(parsed)
                            # Keep only last 10 entries
                            if len(self.serial_buffer) > 10:
                                self.serial_buffer.pop(0)
            except Exception as e:
                logger.error(f"[{self.experiment_id}] Serial read error: {e}")

            await asyncio.sleep(0.01)

    def _parse_serial_line(self, line: str) -> Optional[Dict[str, Any]]:
        """
        Parse a line of CSV data from Teensy.

        Expected format from Teensy (13 fields):
        Time(us),A_X,A_Y,A_SQUAL,A_Surface,B_X,B_Y,B_SQUAL,B_Surface,TotalA_X,TotalA_Y,TotalB_X,TotalB_Y

        Returns normalized format matching serial_manager.py output.
        """
        try:
            # Skip non-data lines (headers, status messages)
            skip_patterns = [
                '[CMD]', '[CONFIG]', '[INFO]', '[START]', '[RUNNING]', '[STOP]',
                'Time(us)', 'Data Header', 'Data Start', '---', '==='
            ]
            if any(pattern in line for pattern in skip_patterns):
                return None

            # Skip lines that don't start with a digit
            if not line or not line[0].isdigit():
                return None

            parts = line.split(',')
            if len(parts) < 13:
                return None

            # Parse dual sensor format (matching serial_manager.py)
            timestamp = int(parts[0])
            a_x = float(parts[1])       # Sensor A displacement X
            a_y = float(parts[2])       # Sensor A displacement Y
            a_squal = int(parts[3])     # Sensor A surface quality
            a_surface = int(parts[4])   # Sensor A on surface
            b_x = float(parts[5])       # Sensor B displacement X
            b_y = float(parts[6])       # Sensor B displacement Y
            b_squal = int(parts[7])     # Sensor B surface quality
            b_surface = int(parts[8])   # Sensor B on surface
            total_a_x = float(parts[9])  # Cumulative A X
            total_a_y = float(parts[10]) # Cumulative A Y
            total_b_x = float(parts[11]) # Cumulative B X
            total_b_y = float(parts[12]) # Cumulative B Y

            # Calculate combined movement from both sensors
            combined_x = (a_x + b_x) / 2.0
            combined_y = (a_y + b_y) / 2.0
            combined_theta = (a_x - b_x) / 2.0  # Rotation from sensor difference

            # Return format matching serial_manager.py
            return {
                'timestamp': timestamp,
                'x': combined_x,
                'y': combined_y,
                'theta': combined_theta,
                'totalA': {'x': total_a_x, 'y': total_a_y},
                'totalB': {'x': total_b_x, 'y': total_b_y},
                'sensorA': {'x': a_x, 'y': a_y, 'squal': a_squal, 'surface': a_surface},
                'sensorB': {'x': b_x, 'y': b_y, 'squal': b_squal, 'surface': b_surface}
            }
        except (ValueError, IndexError) as e:
            logger.debug(f"[{self.experiment_id}] Failed to parse line: {line} - {e}")
            return None

    async def process_serial_data(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Process trackball input and update experiment state.

        Called automatically by backend at high frequency (~50Hz), but data logging
        uses "one data point per Teensy transmission" approach to match 20Hz rate.

        Args:
            data: None (standalone mode reads own serial buffer)

        Returns:
            Updated state dict for frontend, or None if no update
        """
        if not self.is_active:
            return None

        # Get latest serial data from buffer
        if not self.serial_buffer:
            return None

        serial_data = self.serial_buffer[-1]

        # Process trackball input (only if not falling)
        if not self.is_falling:
            self._update_position_from_serial(serial_data)

        # Check for fall condition
        self._check_fall_condition()

        # Check for trial end condition
        if abs(self.position[1]) >= self.TRIAL_END_Y:
            await self._handle_trial_end()

        # Log data (only NEW data - one data point per Teensy transmission)
        current_serial_timestamp = serial_data.get('timestamp')

        if current_serial_timestamp != self.last_logged_serial_timestamp:
            # This is NEW data - log it!
            self._log_data()
            self.last_logged_serial_timestamp = current_serial_timestamp

            if self._duplicate_count > 0:
                logger.debug(f"[{self.experiment_id}] Skipped {self._duplicate_count} duplicates")
                self._duplicate_count = 0
        else:
            # Duplicate data - skip logging
            self._duplicate_count += 1

        return self.get_state()

    async def process_position_update(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process position update from frontend physics engine.

        Frontend sends position every ~20Hz. Backend checks for events
        (trial end, fall timeout) and either echoes position or sends reset.

        Args:
            data: Position dict with keys: x, y (height), z, theta

        Returns:
            Position dict to send back (same for confirmation, different for reset)
        """
        if not self.is_active:
            return data  # Echo back

        # Update position from frontend
        # Note: Frontend Z is our Y (forward/backward), Frontend Y is our Z (height)
        self.position[0] = data.get('x', 0)
        self.position[1] = data.get('z', 0)  # Frontend Z -> Backend Y
        self.position[2] = data.get('y', 0)  # Frontend Y (height) -> Backend Z
        self.position[3] = data.get('theta', 0)

        # Check for fall condition
        current_z = self.position[2]
        if current_z < self.PLAYER_RADIUS and self.fall_start_time is None:
            self.fall_start_time = datetime.now()
            self.is_falling = True
            logger.info(f"[{self.experiment_id}] Player falling (height: {current_z:.2f}m)")
        elif current_z >= self.PLAYER_RADIUS:
            self.fall_start_time = None
            self.is_falling = False

        # Check fall timeout
        need_reset = False
        if self.fall_start_time is not None:
            fall_duration = (datetime.now() - self.fall_start_time).total_seconds() * 1000
            if fall_duration > self.FALL_RESET_TIME:
                logger.info(f"[{self.experiment_id}] Fall timeout ({fall_duration:.0f}ms) - resetting player")
                need_reset = True

        # Check for trial end condition
        if abs(self.position[1]) >= self.TRIAL_END_Y:
            logger.info(f"[{self.experiment_id}] Trial end detected (Y={self.position[1]:.2f})")
            await self._handle_trial_end()
            need_reset = True

        # Log data
        self._log_data()

        # Return position (reset if needed, otherwise confirm)
        if need_reset:
            self._reset_player()
            return {
                'x': 0.0,
                'y': self.PLAYER_RADIUS,  # Height
                'z': 0.0,
                'theta': 0.0
            }
        else:
            # Echo back the position (confirmation)
            return data

    def _update_position_from_serial(self, data: Dict[str, Any]):
        """Convert serial data to position/velocity updates."""
        try:
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

            theta = self.position[3]
            world_vx = vx * np.cos(theta) - vy * np.sin(theta)
            world_vz = -vx * np.sin(theta) - vy * np.cos(theta)

            self.velocity[0] = world_vx
            self.velocity[1] = world_vz
            self.velocity[2] = 0.0

            self.position[0] += self.velocity[0] * self.DT
            self.position[1] += self.velocity[1] * self.DT

            raw_theta = float(data.get('theta', 0))
            delta_theta = raw_theta * self.ROTATION_SENSITIVITY
            self.position[3] += delta_theta

            # Normalize theta to [-π, π]
            while self.position[3] > np.pi:
                self.position[3] -= 2 * np.pi
            while self.position[3] < -np.pi:
                self.position[3] += 2 * np.pi

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error processing serial data: {e}")

    def _check_fall_condition(self):
        """Check if player has fallen off the platform."""
        current_z = self.position[2]

        # Use a tolerance threshold to avoid physics engine fluctuations
        # Only consider falling if significantly below player radius
        FALL_THRESHOLD = self.PLAYER_RADIUS - 0.2  # 0.3m instead of 0.5m

        if current_z < FALL_THRESHOLD and self.fall_start_time is None:
            self.fall_start_time = datetime.now()
            self.is_falling = True
            # Lock horizontal movement during fall: set velocity[2] = 0
            self.velocity[2] = 0.0
            logger.info(f"[{self.experiment_id}] Player falling (height: {current_z:.2f}m) - locking horizontal velocity")
        elif current_z >= FALL_THRESHOLD:
            self.fall_start_time = None
            self.is_falling = False
            # Resume physics engine control: set velocity[2] = None
            self.velocity[2] = None
            logger.debug(f"[{self.experiment_id}] Player recovered - resuming physics engine")

        if self.fall_start_time is not None:
            fall_duration = (datetime.now() - self.fall_start_time).total_seconds() * 1000
            if fall_duration > self.FALL_RESET_TIME:
                logger.debug(f"[{self.experiment_id}] Fall timeout - resetting player")
                self._reset_player()

    async def _handle_trial_end(self):
        """Handle trial completion: deliver reward and reset position."""
        if self.is_trial_end:
            return

        self.is_trial_end = True
        self.trial_number += 1

        logger.info(f"[{self.experiment_id}] Trial {self.trial_number} completed")

        # Deliver water (direct DAQ control)
        success = await self._deliver_water()
        if success:
            logger.info(f"[{self.experiment_id}] Reward {self.num_rewards} delivered")
        else:
            logger.warning(f"[{self.experiment_id}] Water delivery failed")

        self._reset_player()
        self.is_trial_end = False
        self.is_trial_start = True

    async def _deliver_water(self) -> bool:
        """Deliver water reward using direct DAQ control."""
        if not self.daq_task:
            return False

        try:
            # Send 5V pulse for 25ms
            self.daq_task.write(5.0)
            await asyncio.sleep(0.025)
            self.daq_task.write(0.0)

            self.num_rewards += 1
            return True

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Water delivery error: {e}")
            return False

    def _reset_player(self):
        """Reset player to starting position."""
        logger.debug(f"[{self.experiment_id}] Resetting player")
        self.position = np.array([0.0, 0.0, self.PLAYER_RADIUS, 0.0])
        # Reset velocity with velocity[2] = None to restore physics engine control
        self.velocity = [0.0, 0.0, None, 0.0]
        self.fall_start_time = None
        self.is_falling = False

    def _log_data(self):
        """Write current state to data file (direct file I/O)."""
        if self.data_file:
            timestamp = datetime.now().timestamp()
            line = (
                f"{timestamp}\t"
                f"{self.position[0]}\t{self.position[1]}\t{self.position[2]}\t{self.position[3]}\t"
                f"{self.velocity[0]}\t{self.velocity[1]}\t{self.velocity[2]}\t{self.velocity[3]}\t"
                f"{self.trial_number}\t{self.num_rewards}\n"
            )
            self.data_file.write(line)
            self.data_file.flush()

    def get_state(self) -> Dict[str, Any]:
        """Get current experiment state for frontend rendering."""
        return {
            'player': {
                'position': self.position.tolist(),
                'velocity': list(self.velocity)  # velocity is already a list, ensure it's copied
            },
            'experiment': {
                'trialNumber': self.trial_number,
                'numRewards': self.num_rewards,
                'isActive': self.is_active,
                'isFalling': self.is_falling,
                'isTrialStart': self.is_trial_start,
                'isTrialEnd': self.is_trial_end,
                'elapsedTime': self._get_elapsed_time()
            },
            'serial_connected': self.serial_port is not None and self.serial_port.is_open,
            'serial_port': self.serial_port.port if self.serial_port else None,
            'state': 'running' if self.is_active else 'stopped'
        }

    def _get_elapsed_time(self) -> float:
        """Get elapsed time since experiment start."""
        if self.start_time:
            return (datetime.now() - self.start_time).total_seconds()
        return 0.0

    async def terminate(self) -> Dict[str, Any]:
        """Clean up all hardware resources."""
        logger.info(f"[{self.experiment_id}] ========== STARTING CLEANUP ==========")
        logger.info(f"[{self.experiment_id}] Total trials: {self.trial_number}")
        logger.info(f"[{self.experiment_id}] Total rewards: {self.num_rewards}")

        # === 1. STOP SERIAL PORT ===
        try:
            if self.serial_port and self.serial_port.is_open:
                # Send STOP command
                self.serial_port.write(b"STOP\n")
                await asyncio.sleep(0.2)

                # Cancel background read task
                if self.serial_read_task:
                    self.serial_read_task.cancel()
                    try:
                        await self.serial_read_task
                    except asyncio.CancelledError:
                        pass

                # Close serial port
                self.serial_port.close()
                logger.info(f"[{self.experiment_id}] Serial port closed")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error closing serial port: {e}")

        # === 2. CLOSE DAQ TASK ===
        try:
            if self.daq_task:
                self.daq_task.close()
                logger.info(f"[{self.experiment_id}] DAQ task closed")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error closing DAQ: {e}")

        # === 3. CLOSE DATA FILE ===
        try:
            if self.data_file:
                self.data_file.close()
                logger.info(f"[{self.experiment_id}] Data file closed")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error closing data file: {e}")

        elapsed = self._get_elapsed_time()
        logger.info(f"[{self.experiment_id}] Total duration: {elapsed:.1f} seconds")

        self.is_active = False

        return {
            'trialNumber': self.trial_number,
            'numRewards': self.num_rewards,
            'elapsedTime': elapsed,
            'rewardRate': self.num_rewards / elapsed if elapsed > 0 else 0
        }
