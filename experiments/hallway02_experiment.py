"""
EXPERIMENT_ID: vue_style_hallway
EXPERIMENT_NAME: Vue-Style Hallway Experiment (Event-Driven Architecture)
HARDWARE_MODE: standalone


Usage:
    experiment = Experiment("vue_style_hallway", config)
    await experiment.initialize(config)

    Config should include:
    {
        'port': 'COM3',              # Serial port (Electron default: COM3)
        'baudRate': 115200,          # Baud rate
        'daqDevice': 'Dev1',         # NI-DAQ device
        'daqChannel': 'ao0',         # Water delivery channel
        'trialEndY': 70.0,           # Trial end position
        'waterVoltage': 5.0,         # Water solenoid voltage
        'waterDurationMs': 17        # Water pulse duration (Electron default: 17ms)
    }
"""

from typing import Dict, Any, Optional
import numpy as np
from datetime import datetime
import asyncio
import logging
import os

logger = logging.getLogger(__name__)


class Experiment:
    """
    Vue-style hallway experiment with Electron preprocessing logic.

    Fully replicates the Electron/Vue data processing pipeline:
    - Electron main.js: 13-field CSV parsing and water delivery
    - Vue frontend: motion processing and fall detection
    - Frontend physics engine: position sync for accurate fall timeout detection

    Hardware Mode: STANDALONE
    - User directly initializes all hardware
    - Persistent DAQ task for water delivery (like Electron)
    - Complete transparency and control

    Key Methods:
    - process_serial_data(): Handle trackball input from serial port
    - process_position_update(): Sync with frontend physics engine (CRITICAL for falls)
    """

    # Declare standalone mode
    HARDWARE_MODE = 'standalone'

    def __init__(self, experiment_id: str, config: Dict[str, Any], hardware_manager=None, event_callback=None):
        """
        Initialize vue-style hallway experiment.

        Args:
            experiment_id: Unique identifier (e.g., "vue_style_hallway")
            config: Configuration dictionary from frontend
            hardware_manager: Not used in standalone mode (always None)
            event_callback: Callback function for sending events to frontend (callable)
        """
        self.experiment_id = experiment_id
        self.config = config
        self.event_callback = event_callback  # Callback for sending events to frontend

        # Hallway dimensions
        self.HALLWAY_LENGTH = 200.0
        self.HALLWAY_WIDTH = 40.0
        self.WALL_HEIGHT = 10.0
        self.BLUE_SEGMENT_LENGTH = 30.0

        # Physics parameters
        self.PLAYER_RADIUS = 0.5
        self.MAX_LINEAR_VELOCITY = 100.0
        self.DT = 1.0 / 20.0  # 20Hz

        # Conversion factor (matches frontend PythonCustomScene.vue)
        self.ENCODER_TO_CM = 0.0349

        # Trial parameters
        self.TRIAL_END_Y = 70.0
        self.FALL_RESET_TIME = 5000  # milliseconds

        # Water delivery parameters (MATCHES ELECTRON)
        self.WATER_VOLTAGE = 5.0      # Electron default: 5.0V
        self.WATER_DURATION_MS = 17   # Electron default: 17ms

        # State tracking
        self.position = np.array([0.0, 0.0, self.PLAYER_RADIUS, 0.0])  # [x, z, y(height), theta]
        self.velocity = [0.0, 0.0, 0.0, 0.0]  # [vx, vz, vy, vtheta]
        self.trial_number = 0
        self.num_rewards = 0
        self.fall_count = 0
        self.is_active = False
        self.start_time = None

        self.fall_start_time = None
        self.is_falling = False

        # Trial timing (MATCHES ELECTRON)
        self.trial_start_time = None

        # Hardware resources (initialized in initialize())
        self.serial_port = None
        self.daq_task = None  # Persistent task (like Electron)
        self.data_file = None
        self.data_file_path = None
        self.serial_read_task = None
        self.serial_buffer = []

        # Raw sensor data tracking
        self.last_sensor_data = None

        # Position update tracking
        self.position_update_count = 0

        # Event-driven architecture: sequence number for serial data
        self._serial_seq = 0
        self.pending_serial_data = {}  # {seq: raw_data} for matching with position updates

        # Real-time theta tracking (backend accumulates theta to avoid lag)
        # This is used for velocity calculation, separate from self.position[3] which comes from frontend
        self.realtime_theta = 0.0

    async def initialize(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Initialize experiment with direct hardware setup.

        Matches Electron initialization:
        1. Serial port with init string (like main.js)
        2. Persistent DAQ task for water delivery
        3. Dual log files (data + timing)

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
        self.WATER_VOLTAGE = config.get('waterVoltage', self.WATER_VOLTAGE)
        self.WATER_DURATION_MS = config.get('waterDurationMs', self.WATER_DURATION_MS)

        # === 1. INITIALIZE SERIAL PORT (ELECTRON STYLE) ===
        try:
            import serial

            port = config.get('port', 'COM3')  # Electron default: COM3
            baudrate = config.get('baudRate', 115200)

            self.serial_port = serial.Serial(
                port=port,
                baudrate=baudrate,
                timeout=0.001,  # Non-blocking reads
                write_timeout=1.0
            )

            logger.info(f"[{self.experiment_id}] Serial port opened: {port} @ {baudrate} baud")

            # Wait for initialization (like Electron: 2000ms)
            await asyncio.sleep(2.0)

            # Send initialization string (MATCHES ELECTRON: "10000,50,10,1\n")
            init_string = "10000,50,10,1\n"
            self.serial_port.write(init_string.encode('utf-8'))
            logger.info(f"[{self.experiment_id}] Initialization string sent: {init_string.strip()}")

            # Start background task to read serial data
            self.serial_read_task = asyncio.create_task(self._serial_read_loop())

            await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Failed to initialize serial port: {e}")
            raise

        # === 2. INITIALIZE WATER DELIVERY (ELECTRON STYLE - PERSISTENT TASK) ===
        try:
            import nidaqmx
            from nidaqmx.constants import VoltageUnits, SampleTimingType

            daq_device = config.get('daqDevice', 'Dev1')
            daq_channel = config.get('daqChannel', 'ao0')

            # Create persistent DAQ task (like water_delivery.py)
            self.daq_task = nidaqmx.Task()
            self.daq_task.ao_channels.add_ao_voltage_chan(
                f"{daq_device}/{daq_channel}",
                min_val=0.0,
                max_val=5.0,
                units=VoltageUnits.VOLTS
            )
            # Set timing to ON_DEMAND (like water_delivery.py)
            self.daq_task.timing.samp_timing_type = SampleTimingType.ON_DEMAND

            logger.info(f"[{self.experiment_id}] Persistent DAQ task created: {daq_device}/{daq_channel}")
            logger.info(f"[{self.experiment_id}] Water delivery: {self.WATER_VOLTAGE}V, {self.WATER_DURATION_MS}ms")

        except Exception as e:
            logger.warning(f"[{self.experiment_id}] DAQ not available: {e}")
            self.daq_task = None

        # === 3. OPEN DATA FILES (DUAL LOGS) ===
        try:
            # Create logs directory (like Electron creates VirmenData)
            os.makedirs(r"D:\VirmenData", exist_ok=True)
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")

            # Main data log (matches NewSerialHallwayScene.vue format)
            self.data_file_path = f"D:\\VirmenData\\{self.experiment_id}-{timestamp}.txt"
            self.data_file = open(self.data_file_path, 'w')
            # Format: x, -y, theta, raw_x, raw_y, water, timestamp, scene_name
            # data_header = "x\t-y\ttheta\traw_x\traw_y\twater\ttimestamp\tscene_name\n"
            # self.data_file.write(data_header)

            logger.info(f"[{self.experiment_id}] Data file opened: {self.data_file_path}")

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Failed to open data files: {e}")
            # Cleanup
            if self.serial_port:
                self.serial_port.close()
            if self.daq_task:
                self.daq_task.close()
            raise

        # === 4. INITIALIZE EXPERIMENT STATE ===
        self.position = np.array([0.0, 0.0, self.PLAYER_RADIUS, 0.0])
        self.velocity = [0.0, 0.0, 0.0, 0.0]
        self.trial_number = 0
        self.num_rewards = 0
        self.fall_count = 0
        self.is_active = True
        self.start_time = datetime.now()
        self.trial_start_time = datetime.now()  # Initialize trial timer

        self.fall_start_time = None
        self.is_falling = False

        logger.info(f"[{self.experiment_id}] Initialization complete")
        logger.info(f"[{self.experiment_id}] Trial end at Y = ±{self.TRIAL_END_Y}")
        logger.info(f"[{self.experiment_id}] Using Vue conversion factor: {self.ENCODER_TO_CM}")
        logger.info(f"[{self.experiment_id}] ========== INITIALIZE COMPLETE ==========")

        return self.get_state()

    async def _serial_read_loop(self):
        """Background task to read serial data and send to frontend.
        
        EVENT-DRIVEN ARCHITECTURE:
        - Read serial data -> parse -> calculate velocity -> send to frontend
        - DO NOT update position here (frontend physics is the single source)
        - DO NOT log data here (logging happens in process_position_update)
        """
        logger.info(f"[{self.experiment_id}] Serial read loop started (event-driven mode)")

        while self.serial_port and self.serial_port.is_open:
            try:
                if self.serial_port.in_waiting > 0:
                    line = self.serial_port.readline().decode('utf-8').strip()
                    if line:
                        # Parse the data
                        parsed = self._parse_serial_line(line)
                        if parsed:
                            # Increment sequence number
                            self._serial_seq += 1
                            
                            # Store as latest data (for logging when position comes back)
                            self.last_sensor_data = parsed
                            
                            # Store in pending map for sequence matching
                            self.pending_serial_data[self._serial_seq] = parsed
                            
                            # Clean up old pending data (keep last 100)
                            if len(self.pending_serial_data) > 100:
                                oldest_key = min(self.pending_serial_data.keys())
                                del self.pending_serial_data[oldest_key]

                            # First, update realtime_theta BEFORE calculating velocity
                            # This ensures we use the current theta, not lagged theta
                            raw_theta = float(parsed.get('theta', 0))
                            delta_theta = raw_theta * 0.05
                            self.realtime_theta += delta_theta

                            # Calculate world velocities using realtime_theta (no lag!)
                            standardized_data = self._calculate_standardized_motion_realtime(parsed)

                            # Send serial_data event to frontend (event-driven)
                            # Backend calculates world coordinates using realtime theta
                            if self.event_callback:
                                try:
                                    # Send calculated velocity and deltaTheta
                                    data_to_send = {
                                        'seq': self._serial_seq,
                                        'velocity': standardized_data['velocity'],
                                        'deltaTheta': standardized_data['deltaTheta'],
                                        'timestamp': parsed.get('timestamp'),
                                        'water': parsed.get('water', 0),
                                        'frameCount': parsed.get('frameCount', 0)
                                    }

                                    # Debug: log first few serial_data events
                                    if not hasattr(self, '_serial_data_count'):
                                        self._serial_data_count = 0

                                    if self._serial_data_count < 5:
                                        vel = standardized_data['velocity']
                                        logger.info(f"[{self.experiment_id}] Sending serial_data seq={self._serial_seq}: vel={{x:{vel['x']:.4f}, z:{vel['z']:.4f}}}, theta={self.realtime_theta:.4f}")
                                        self._serial_data_count += 1

                                    await self.event_callback('serial_data', data_to_send)
                                except Exception as e:
                                    logger.error(f"[{self.experiment_id}] Error in event callback: {e}")

                            # EVENT-DRIVEN: Do NOT update position or log here!
                            # Position comes from frontend, logging happens in process_position_update

            except Exception as e:
                logger.error(f"[{self.experiment_id}] Serial read error: {e}")

            await asyncio.sleep(0.001)  # 1ms poll rate for responsive serial reading

    def _parse_serial_line(self, line: str) -> Optional[Dict[str, Any]]:
        """
        Parse a line of CSV data from Teensy.

        ELECTRON MAIN.JS PREPROCESSING (lines 549-583):
        Expected 13-field format:
        timestamp,left_dx,left_dy,left_dt,right_dx,right_dy,right_dt,x,y,theta,water,direction,frameCount

        Returns format matching Electron preprocessing output.
        """
        try:
            # Skip non-data lines
            skip_patterns = [
                '[CMD]', '[CONFIG]', '[INFO]', '[START]', '[RUNNING]', '[STOP]',
                'Time(us)', 'Data Header', 'Data Start', '---', '==='
            ]
            if any(pattern in line for pattern in skip_patterns):
                return None

            # Skip lines that don't start with a digit
            if not line or not line[0].isdigit():
                return None

            values = line.split(',')
            if len(values) < 13:
                return None

            # Parse 13-field format (MATCHES ELECTRON main.js:554-573)
            parsed_data = {
                'timestamp': values[0],
                'leftSensor': {
                    'dx': float(values[1]),
                    'dy': float(values[2]),
                    'dt': float(values[3])
                },
                'rightSensor': {
                    'dx': float(values[4]),
                    'dy': float(values[5]),
                    'dt': float(values[6])
                },
                'x': float(values[7]),
                'y': float(values[8]),
                'theta': float(values[9]),
                'water': int(values[10]),
                'direction': float(values[11]),
                'frameCount': int(values[12])
            }

            return parsed_data

        except (ValueError, IndexError) as e:
            logger.debug(f"[{self.experiment_id}] Failed to parse line: {line} - {e}")
            return None

    async def process_serial_data(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Return current experiment state for frontend.

        EVENT-DRIVEN ARCHITECTURE:
        - Serial data is read in _serial_read_loop() and sent to frontend
        - Position updates come from frontend via process_position_update()
        - This method just returns the current state for status display

        Args:
            data: None (standalone mode reads own serial buffer)

        Returns:
            Updated state dict for frontend, or None if no update
        """
        if not self.is_active:
            return None

        # Return current state
        return self.get_state()

    async def process_position_update(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process position update from frontend physics engine.

        EVENT-DRIVEN ARCHITECTURE:
        - Frontend sends position after processing serial_data
        - This is the SINGLE SOURCE OF TRUTH for position
        - Log data here using frontend position
        - Check for trial end and fall events

        Args:
            data: Position dict with keys: x, y (height), z, theta, seq (optional)
                  Note: Frontend Z is our Y (forward/back)
                        Frontend Y is our Z (height)

        Returns:
            Position dict with action, lockMovement flag, and position data
        """
        if not self.is_active:
            return {
                'action': 'update',
                'lockMovement': False,
                **data
            }

        self.position_update_count += 1
        
        # Get sequence number if provided (for matching with serial data)
        seq = data.get('seq')

        # Update position from frontend physics engine (SINGLE SOURCE OF TRUTH)
        # Coordinate mapping: Frontend (x, y, z) -> Backend (x, z, y)
        # - Frontend X -> Backend X (left/right)
        # - Frontend Y -> Backend Z (height/vertical)
        # - Frontend Z -> Backend Y (forward/backward)
        self.position[0] = data.get('x', 0)
        self.position[1] = data.get('z', 0)  # Frontend Z -> Backend Y
        self.position[2] = data.get('y', 0)  # Frontend Y (height) -> Backend Z
        self.position[3] = data.get('theta', 0)

        # Check for fall condition (Vue-style)
        current_height = self.position[2]

        # Use a very forgiving threshold to avoid false positives from physics engine jitter
        # Normal physics oscillation is ~0.35-0.45m, so we use 0.2m as threshold
        # Only detect real falls (player went through floor or fell off edge)
        FALL_THRESHOLD = self.PLAYER_RADIUS * 0.4  # 40% of player radius (0.2m for 0.5m radius)
        RECOVERY_THRESHOLD = self.PLAYER_RADIUS * 0.5  # Recover at 50% (0.25m) to add hysteresis

        if current_height < FALL_THRESHOLD and self.fall_start_time is None:
            # Start tracking fall
            self.fall_start_time = datetime.now()
            self.is_falling = True
            self.fall_count += 1
            logger.info(f"[{self.experiment_id}] Fall detected! Total falls: {self.fall_count} (height: {current_height:.2f}m)")
        elif current_height >= RECOVERY_THRESHOLD and self.is_falling:
            # Reset fall tracking when recovered
            self.fall_start_time = None
            self.is_falling = False
            logger.info(f"[{self.experiment_id}] Fall recovered (height: {current_height:.2f}m)")

        # Check fall timeout and reset if needed
        need_reset = False
        fall_timeout_triggered = False
        if self.fall_start_time is not None:
            fall_duration = (datetime.now() - self.fall_start_time).total_seconds() * 1000
            if fall_duration > self.FALL_RESET_TIME:
                logger.info(f"[{self.experiment_id}] Fall timeout ({fall_duration:.0f}ms) - resetting player")
                fall_timeout_triggered = True
                need_reset = True

        # Check for trial end condition
        trial_end_triggered = False
        if abs(self.position[1]) >= self.TRIAL_END_Y:
            logger.info(f"[{self.experiment_id}] Trial end detected (Y={self.position[1]:.2f})")
            trial_end_triggered = True
            need_reset = True

        # EVENT-DRIVEN: Log data here using frontend position (single source of truth)
        # IMPORTANT: Always log the current position BEFORE reset
        # This ensures we capture the exact position that triggered trial end/fall reset
        if self.last_sensor_data:
            if trial_end_triggered:
                # Log the position that triggered trial end WITH water reward marker
                self._log_data(water_delivered=True)
                # Handle trial end (deliver water, increment counters) AFTER logging
                await self._handle_trial_end()
            elif fall_timeout_triggered:
                # Log the position when fall timeout triggered (before reset)
                self._log_data()
            elif not need_reset:
                # Normal frame: log without water
                self._log_data()

        # Flush data file periodically on important events
        if self.data_file and (need_reset or self.is_falling):
            self.data_file.flush()

        # Clean up matched pending serial data
        if seq and seq in self.pending_serial_data:
            del self.pending_serial_data[seq]

        # Return position with action, lock flag, and current velocity
        if need_reset:
            self._reset_player()
            # Log the reset position (starting point of new trial)
            self._log_data()
            
            return {
                'action': 'set',
                'lockMovement': False,  # Unlock after teleport
                'x': 0.0,
                'y': self.PLAYER_RADIUS,  # Frontend Y = height
                'z': 0.0,                 # Frontend Z = forward/back
                'theta': 0.0,
                'velocity': [0.0, 0.0, 0.0, 0.0]
            }
        elif self.is_falling:
            # During fall: echo position but LOCK horizontal movement
            return {
                'action': 'update',
                'lockMovement': True,  # Lock XZ movement during fall
                **data
            }
        else:
            # Normal: echo back the position (confirmation)
            return {
                'action': 'update',
                'lockMovement': False,
                **data
            }

    def _calculate_standardized_motion_realtime(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Calculate standardized motion data using REALTIME theta (no lag).
        
        Key difference from _calculate_standardized_motion:
        - Uses self.realtime_theta instead of self.position[3]
        - self.realtime_theta is accumulated in _serial_read_loop BEFORE this call
        - This eliminates the 50ms theta lag that caused stuttering
        
        Performs ALL conversions so frontend can directly apply the values:
        - velocity: world coordinates (m/s), directly apply to physics engine
        - deltaTheta: rotation increment (radians), directly add to current theta

        Args:
            data: Parsed serial data with x, y, theta

        Returns:
            Dictionary with standardized motion data:
            {
                'velocity': {'x': m/s, 'y': None, 'z': m/s},
                'deltaTheta': radians
            }
        """
        try:
            # Extract raw displacement values from serial data
            raw_x = float(data.get('x', 0))
            raw_y = float(data.get('y', 0))
            raw_theta = float(data.get('theta', 0))

            # Convert displacement to velocity (matches frontend: raw * 0.0364 / DT)
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

            # Use REALTIME theta for world transformation (no lag!)
            # self.realtime_theta was already updated in _serial_read_loop
            theta = self.realtime_theta

            # World coordinate transformation (matches NewSerialHallwayScene.vue)
            world_vx = -vx * np.cos(theta) - vy * np.sin(theta)
            world_vz = vx * np.sin(theta) - vy * np.cos(theta)

            # Calculate deltaTheta (already computed in _serial_read_loop, but return it here)
            delta_theta = raw_theta * 0.05

            # Lock movement when falling
            if self.is_falling:
                world_vx = 0.0
                world_vz = 0.0
                delta_theta = 0.0

            return {
                'velocity': {
                    'x': world_vx,
                    'y': None,  # Vertical velocity controlled by physics engine (gravity)
                    'z': world_vz
                },
                'deltaTheta': delta_theta
            }

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error calculating standardized motion: {e}")
            return {
                'velocity': {'x': 0.0, 'y': None, 'z': 0.0},
                'deltaTheta': 0.0
            }

    def _calculate_standardized_motion(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        DEPRECATED: Use _calculate_standardized_motion_realtime instead.
        
        This method uses self.position[3] which has ~50ms lag, causing stuttering.
        Kept for reference only.
        """
        try:
            raw_x = float(data.get('x', 0))
            raw_y = float(data.get('y', 0))
            raw_theta = float(data.get('theta', 0))

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

            # DEPRECATED: This theta is lagged by ~50ms
            theta = self.position[3]

            world_vx = -(vx * np.cos(theta) - vy * np.sin(theta))
            world_vz = -vx * np.sin(theta) - vy * np.cos(theta)

            delta_theta = raw_theta * 0.05

            if self.is_falling:
                world_vx = 0.0
                world_vz = 0.0
                delta_theta = 0.0

            return {
                'velocity': {
                    'x': world_vx,
                    'y': None,
                    'z': world_vz
                },
                'deltaTheta': delta_theta
            }

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error calculating standardized motion: {e}")
            return {
                'velocity': {'x': 0.0, 'y': None, 'z': 0.0},
                'deltaTheta': 0.0
            }

    # NOTE: The following methods have been removed in the event-driven architecture:
    # - _update_position_from_standardized(): No longer needed, position comes from frontend
    # - _update_position_from_velocities(): No longer needed, position comes from frontend
    # - _check_fall_condition(): Fall detection now happens in process_position_update()

    async def _handle_trial_end(self):
        """
        Handle trial completion: deliver reward only.
        
        NOTE: Position reset and data logging are handled by caller (process_position_update).
        This method only:
        - Increments trial counter
        - Delivers water reward
        - Logs timing info
        - Resets trial timer

        VUE-STYLE (NewSerialHallwayScene.vue:195-220):
        - Water delivery happens after position is logged
        """
        self.trial_number += 1

        # Calculate trial time (MATCHES ELECTRON main.js:734-738)
        current_time = datetime.now()
        trial_time = (current_time - self.trial_start_time).total_seconds()

        logger.info(f"[{self.experiment_id}] Trial {self.trial_number} completed at Y={self.position[1]:.2f}")

        # Deliver water reward
        success = await self._deliver_water()

        if success:
            # Log timing info (MATCHES ELECTRON console output, line 738)
            logger.info(f"[{self.experiment_id}] Reward #{self.num_rewards} delivered! Trial time: {trial_time:.2f} seconds")
        else:
            logger.warning(f"[{self.experiment_id}] Water delivery failed")

        # Reset trial timer for next trial (MATCHES ELECTRON line 741)
        self.trial_start_time = datetime.now()

    async def _deliver_water(self) -> bool:
        """
        Deliver water reward using persistent DAQ task.

        ELECTRON STYLE (water_delivery.py:12-18):
        - 5V pulse (configurable)
        - 17ms duration (Electron default, configurable)
        - Uses persistent DAQ task
        """
        if not self.daq_task:
            logger.warning(f"[{self.experiment_id}] DAQ not available for water delivery")
            return False

        try:
            duration_s = self.WATER_DURATION_MS / 1000.0

            # Send voltage pulse (MATCHES water_delivery.py:15-18)
            self.daq_task.write([self.WATER_VOLTAGE], auto_start=True)
            await asyncio.sleep(duration_s)
            # Reset to 0V
            self.daq_task.write([0.0], auto_start=True)

            self.num_rewards += 1
            return True

        except Exception as e:
            logger.error(f"[{self.experiment_id}] Water delivery error: {e}")
            return False

    def _reset_player(self):
        """
        Reset player to starting position.

        VUE-STYLE (NewSerialHallwayScene.vue:183-188):
        - Reset position, rotation, and velocity
        """
        logger.info(f"[{self.experiment_id}] Resetting player to start position")

        # Reset position
        self.position = np.array([0.0, 0.0, self.PLAYER_RADIUS, 0.0])

        # Reset realtime theta (used for velocity calculation)
        self.realtime_theta = 0.0

        # Reset velocity
        self.velocity = [0.0, 0.0, 0.0, 0.0]

        # Reset fall tracking
        self.fall_start_time = None
        self.is_falling = False

    def _log_data(self, water_delivered=False):
        """
        Write current state to data file.

        Matches NewSerialHallwayScene.vue format:
        x, -y, theta, raw_x, raw_y, water, timestamp, scene_name

        Args:
            water_delivered: Whether water reward was just delivered
        """
        if self.data_file and self.last_sensor_data:
            # Use Teensy timestamp from serial data (not Python timestamp)
            timestamp = self.last_sensor_data.get('timestamp', 0)

            # Format matches NewSerialHallwayScene.vue line 159
            # x (3 decimals), -y (3 decimals, negated), theta (3 decimals), raw_x, raw_y, water (0/1), timestamp, scene_name
            line = (
                f"{self.position[0]:.3f}\t"           # x
                f"{-self.position[1]:.3f}\t"          # -y (negated!)
                f"{self.position[3]:.3f}\t"           # theta
                f"{self.last_sensor_data.get('x', 0)}\t"  # raw_x
                f"{self.last_sensor_data.get('y', 0)}\t"  # raw_y
                f"{1 if water_delivered else 0}\t"   # water
                f"{timestamp}\t"                       # Teensy timestamp (microseconds)
                f"{self.experiment_id}\n"              # scene_name
            )
            self.data_file.write(line)
            # No flush here - will be flushed periodically by caller for better performance

    def get_state(self) -> Dict[str, Any]:
        """Get current experiment state for frontend rendering."""
        return {
            'player': {
                'position': self.position.tolist(),
                'velocity': list(self.velocity)
            },
            'experiment': {
                'trialNumber': self.trial_number,
                'numRewards': self.num_rewards,
                'fallCount': self.fall_count,
                'isActive': self.is_active,
                'isFalling': self.is_falling,
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
        logger.info(f"[{self.experiment_id}] Total falls: {self.fall_count}")

        # === 1. STOP SERIAL PORT ===
        try:
            if self.serial_port and self.serial_port.is_open:
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

        # === 2. CLOSE DAQ TASK (Persistent task cleanup) ===
        try:
            if self.daq_task:
                # Ensure output is 0V before closing
                try:
                    self.daq_task.write([0.0], auto_start=True)
                except:
                    pass
                self.daq_task.close()
                logger.info(f"[{self.experiment_id}] DAQ task closed")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error closing DAQ: {e}")

        # === 3. CLOSE DATA FILES ===
        try:
            if self.data_file:
                self.data_file.close()
                logger.info(f"[{self.experiment_id}] Data file closed: {self.data_file_path}")
        except Exception as e:
            logger.error(f"[{self.experiment_id}] Error closing data file: {e}")

        elapsed = self._get_elapsed_time()
        logger.info(f"[{self.experiment_id}] Total duration: {elapsed:.1f} seconds")
        logger.info(f"[{self.experiment_id}] ========== CLEANUP COMPLETE ==========")

        self.is_active = False

        return {
            'trialNumber': self.trial_number,
            'numRewards': self.num_rewards,
            'fallCount': self.fall_count,
            'elapsedTime': elapsed,
            'rewardRate': self.num_rewards / elapsed if elapsed > 0 else 0
        }
