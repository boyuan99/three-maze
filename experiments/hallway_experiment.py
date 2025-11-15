"""
EXPERIMENT_ID: hallway02
EXPERIMENT_NAME: Hallway Experiment 02
HARDWARE_MODE: managed

hallway_experiment.py

Python implementation of the hallway experiment for Hallway02.json scene.

This experiment implements a simple linear track task:
- Mouse navigates down a virtual hallway using a trackball
- Reaching the end (±70 units) triggers water reward
- Player automatically resets to start position
- All data is logged automatically

This is a direct Python port of hallway02Control.js, demonstrating
how JavaScript experiment logic can be migrated to Python for better
performance and hardware integration.

Hardware Mode: MANAGED
- Uses backend's shared hardware_manager for serial port and water delivery
- No manual hardware initialization or cleanup required
- Simple and safe for basic experiments

Usage:
    Register with backend server:
    experiment = HallwayExperiment("hallway02", config, hardware_manager)
    await experiment.initialize(config)
"""

from typing import Dict, Any, Optional
import numpy as np
from datetime import datetime
from backend.src.experiment_base import ExperimentBase


class HallwayExperiment(ExperimentBase):
    """
    Hallway navigation experiment with automatic reward delivery.

    This experiment processes trackball input and delivers water rewards
    when the mouse reaches either end of the hallway.

    Hardware Mode: MANAGED
    - Backend provides shared hardware_manager
    - No hardware initialization or cleanup needed
    """

    # Declare managed mode (backend manages hardware)
    HARDWARE_MODE = 'managed'

    def __init__(self, experiment_id: str, config: Dict[str, Any], hardware_manager):
        """
        Initialize hallway experiment in MANAGED mode.

        Args:
            experiment_id: Unique identifier (e.g., "hallway02")
            config: Configuration dictionary from frontend
            hardware_manager: Backend hardware manager for serial/water control
        """
        super().__init__(experiment_id, config, hardware_manager)

        # Hallway dimensions (matching Hallway02.json)
        self.HALLWAY_LENGTH = 200.0  # Total length: 140 + 30 + 30
        self.HALLWAY_WIDTH = 40.0
        self.WALL_HEIGHT = 10.0
        self.BLUE_SEGMENT_LENGTH = 30.0

        # Physics parameters
        self.PLAYER_RADIUS = 0.5
        self.MAX_LINEAR_VELOCITY = 100.0  # units per second
        self.DT = 1.0 / 20.0  # 20Hz sampling rate (matches serial input)

        # Conversion factor from encoder counts to cm
        self.ENCODER_TO_CM = 0.0364

        # Rotation sensitivity (radians per encoder count)
        self.ROTATION_SENSITIVITY = 0.05

        # Trial parameters
        self.TRIAL_END_Y = 70.0  # Trial ends at ±70 (edge of blue zones)
        self.FALL_RESET_TIME = 5000  # 5 seconds (milliseconds)

        # State tracking
        self.fall_start_time = None
        self.is_falling = False
        self.is_trial_start = True
        self.is_trial_end = False

    async def initialize(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """
        Initialize experiment state.

        Args:
            config: Configuration dictionary (can override default parameters)

        Returns:
            Initial state dictionary for frontend
        """
        print(f"Initializing {self.experiment_id} experiment")

        # Allow config to override default parameters
        self.TRIAL_END_Y = config.get('trialEndY', self.TRIAL_END_Y)
        self.PLAYER_RADIUS = config.get('playerRadius', self.PLAYER_RADIUS)
        self.MAX_LINEAR_VELOCITY = config.get('maxVelocity', self.MAX_LINEAR_VELOCITY)

        # Initialize position and state
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

        print(f"Experiment initialized: Trial end at Y = ±{self.TRIAL_END_Y}")

        return {
            'position': self.position.tolist(),
            'velocity': self.velocity.tolist(),
            'trialNumber': self.trial_number,
            'numRewards': self.num_rewards,
            'isActive': self.is_active,
            'config': {
                'trialEndY': self.TRIAL_END_Y,
                'hallwayLength': self.HALLWAY_LENGTH,
                'hallwayWidth': self.HALLWAY_WIDTH
            }
        }

    async def process_serial_data(self, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Process trackball input and update experiment state.

        This is the main experiment loop, called at ~60 Hz.

        Args:
            data: Serial data dict with keys 'x', 'y', 'theta'

        Returns:
            Updated state dict for frontend, or None if no update needed
        """
        if not self.is_active:
            return None

        # Process trackball input (only if not falling)
        if not self.is_falling:
            self._update_position_from_serial(data)

        # Check for fall condition
        self._check_fall_condition()

        # Check for trial end condition
        if abs(self.position[1]) >= self.TRIAL_END_Y:
            await self._handle_trial_end()

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
            # Formula: (encoder_counts * conversion_factor) / dt
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
            # World frame rotation based on current orientation (theta)
            theta = self.position[3]
            world_vx = vx * np.cos(theta) - vy * np.sin(theta)
            world_vz = -vx * np.sin(theta) - vy * np.cos(theta)

            # Update velocity vector
            self.velocity[0] = world_vx
            self.velocity[1] = world_vz
            self.velocity[2] = 0.0  # No vertical velocity

            # Update position using Euler integration
            self.position[0] += self.velocity[0] * self.DT
            self.position[1] += self.velocity[1] * self.DT

            # Handle rotation (direct angle control from theta encoder)
            raw_theta = float(data.get('theta', 0))
            delta_theta = raw_theta * self.ROTATION_SENSITIVITY
            self.position[3] += delta_theta

            # Normalize theta to [-π, π]
            self.position[3] = self.normalize_angle(self.position[3])

        except Exception as e:
            print(f"Error processing serial data: {e}")

    def _check_fall_condition(self):
        """
        Check if player has fallen off the platform.

        If player is below ground level for more than FALL_RESET_TIME,
        automatically reset position.
        """
        current_z = self.position[2]  # Vertical coordinate

        if current_z < self.PLAYER_RADIUS and self.fall_start_time is None:
            # Started falling
            self.fall_start_time = datetime.now()
            self.is_falling = True
            print("Player falling...")
        elif current_z >= self.PLAYER_RADIUS:
            # Back on solid ground
            self.fall_start_time = None
            self.is_falling = False

        # Check if we've been falling too long
        if self.fall_start_time is not None:
            fall_duration = (datetime.now() - self.fall_start_time).total_seconds() * 1000
            if fall_duration > self.FALL_RESET_TIME:
                print("Fall timeout - resetting player")
                self._reset_player()

    async def _handle_trial_end(self):
        """
        Handle trial completion: deliver reward and reset position.

        This prevents multiple triggers using the is_trial_end flag.
        """
        if self.is_trial_end:
            return  # Already handling trial end

        self.is_trial_end = True
        self.trial_number += 1

        print(f"Trial {self.trial_number} completed at Y = {self.position[1]:.2f}")

        # Deliver water reward via hardware manager
        success = await self.deliver_water(amount=1, duration=25)
        if success:
            print(f"Reward {self.num_rewards} delivered")
        else:
            print("Water delivery failed")

        # Reset player after short delay (simulated with immediate reset)
        # In async context, we reset immediately rather than using setTimeout
        self._reset_player()
        self.is_trial_end = False
        self.is_trial_start = True

    def _reset_player(self):
        """
        Reset player to starting position.
        """
        print("Resetting player to start position")
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
            'position': self.position.tolist(),
            'velocity': self.velocity.tolist(),
            'trialNumber': self.trial_number,
            'numRewards': self.num_rewards,
            'isActive': self.is_active,
            'isFalling': self.is_falling,
            'isTrialStart': self.is_trial_start,
            'isTrialEnd': self.is_trial_end,
            'elapsedTime': self.get_elapsed_time()
        }

    async def terminate(self) -> Dict[str, Any]:
        """
        Clean up and finalize experiment.

        Returns:
            Summary statistics dictionary
        """
        print("EXPERIMENT TERMINATED")
        print(f"Total trials completed: {self.trial_number}")
        print(f"Total rewards delivered: {self.num_rewards}")

        elapsed = self.get_elapsed_time()
        print(f"Total duration: {elapsed:.1f} seconds")

        self.is_active = False

        return {
            'trialNumber': self.trial_number,
            'numRewards': self.num_rewards,
            'elapsedTime': elapsed,
            'rewardRate': self.num_rewards / elapsed if elapsed > 0 else 0
        }
