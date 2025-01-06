from control.hallway.state import HallwayState
from control.serial_handler import SerialHandler
from control.utils.data_logger import DataLogger
import numpy as np
import time
import nidaqmx
from typing import Dict, Any, List

class HallwayController:
    def __init__(self):
        self.state = HallwayState()
        self.serial = SerialHandler()
        self.logger = DataLogger()
        self.is_initialized = False

    def initialize(self):
        """Initialize the controller and reset state"""
        print("Controller initializing...", flush=True)
        self.state = HallwayState()

        if not self.is_initialized:
            print("Initializing serial communication...", flush=True)
            self.serial.initialize_communication()
            self.is_initialized = True

        print("Starting new logging session...", flush=True)
        self.logger.start_new_session()

        # Reset trial flags
        self.state.isTrialStart = True
        self.state.isTrialEnd = False
        self.state.trialTimer = 0
        self.state.numrewards = 0
        self.state.rewarding = False
    
    def update(self) -> dict:
        """Update state based on serial input"""
        serial_data = self.serial.read_data()
        if not serial_data:
            return None

        # Do not process movement here; send the raw serial data instead
        self.logger.log_frame(self.state, serial_data)

        # Return the raw serial data
        return serial_data

    def reward_circle_small(self):
        """Implement reward mechanism using NI-DAQmx"""
        try:
            with nidaqmx.Task() as task:
                # Configure analog output channel
                task.ao_channels.add_ao_voltage_chan("Dev1/ao0", min_val=0.0, max_val=5.0)
                task.timing.samp_timing_type = nidaqmx.constants.SampleTimingType.ON_DEMAND

                # Send 5V pulse
                task.write([5], auto_start=True)
                time.sleep(0.025)  # 25ms pause

                # Reset to 0V
                task.write([0], auto_start=True)

        except nidaqmx.DaqError as e:
            print(f"DAQ Error in reward delivery: {e}")
        finally:
            # Properly close the task without resetting the device
            task.close()
            print("Task closed successfully.")

    def termination(self):
        """Clean up resources"""
        print(f"NUM REWARDS: {self.state.numrewards}")
        self.stop_logging()
        if self.serial:
            self.serial.close()

    def stop_logging(self):
        """Safely close the log file"""
        if self.logger and self.logger.file:
            self.logger.file.close()
            print("STOP_LOGGING", flush=True)  # Special command instead of JSON

    def _process_movement(self, serial_data: Dict[str, Any]) -> List[float]:
        """Process movement data from serial input"""
        self.state.position[0] = serial_data['x']
        self.state.position[1] = serial_data['y']
        self.state.position[3] = serial_data['theta']
        self.state.water = serial_data['water']
        self.state.timestamp = serial_data['timestamp']
        return self.state.position

    def _should_end_trial(self) -> bool:
        """Check if trial should end based on position"""
        return abs(self.state.position[1]) >= 50

    def _handle_trial_end(self):
        """Handle end of trial logic"""
        self.state.rewarding = True
        self.state.isTrialEnd = True
        self.state.position = [0, 0, 2, 0]
        self.reward_circle_small()
        self.state.numrewards += 1
        self.state.velocity = [0, 0, 0, 0]

    def update_position(self, position_data):
        """Update the internal position state based on data from the Electron app."""
        if 'x' in position_data:
            self.state.position[0] = position_data['x']
        if 'y' in position_data:
            self.state.position[1] = position_data['y']
        if 'theta' in position_data:
            self.state.position[3] = position_data['theta']
