import datetime
import os
import logging
import json

class DataLogger:
    def __init__(self):
        self.file = None
        
        # Set up debug logger
        self.debug_logger = logging.getLogger('debug')
        self.debug_logger.setLevel(logging.DEBUG)
        
        # Create logs directory if it doesn't exist
        log_dir = os.path.join("D:", "VirmenData", "logs")
        os.makedirs(log_dir, exist_ok=True)
        
        # Create debug log file with timestamp
        timestamp = datetime.datetime.now().strftime("%d-%m-%Y-%H-%M-%S-%a")
        debug_file = os.path.join(log_dir, f"debug_{timestamp}.log")
        debug_handler = logging.FileHandler(debug_file)
        debug_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
        self.debug_logger.addHandler(debug_handler)
        
    def start_new_session(self):
        timestamp = datetime.datetime.now().strftime("%d-%m-%Y-%H-%M-%S-%a")
        filepath = os.path.join("D:", "VirmenData", f"{timestamp}-timedata-simplified.txt")
        
        # Create directory if it doesn't exist
        os.makedirs(os.path.join("D:", "VirmenData"), exist_ok=True)
        
        try:
            self.file = open(filepath, 'w')
            print(f"Successfully opened log file: {filepath}", flush=True)
            self.debug_logger.info(f"Started new session: {filepath}")
        except Exception as e:
            error_msg = f"Failed to open log file: {e}"
            print(error_msg, flush=True)
            self.debug_logger.error(error_msg)
        
    def log_frame(self, state, serial_data):
        """
        Log frame data using JavaScript position and serial data
        state: contains current position from JavaScript
        serial_data: contains displacement data from serial port
        """
        data_line = (
            f"{state.position[0]}\t{state.position[1]}\t{state.position[3]}\t"
            f"{state.currentWorld}\t{serial_data['water']}\t{serial_data['timestamp']}\n"
        )
        if self.file is not None:
            self.file.write(data_line)
            self.file.flush()  # Ensure data is written to disk
            
            # Log to debug file in a more readable format
            debug_data = {
                'position': {
                    'x': state.position[0], 
                    'y': state.position[1], 
                    'theta': state.position[3]
                },
                'displacement': {
                    'dx': serial_data['x'],
                    'dy': serial_data['y'],
                    'dtheta': serial_data['theta']
                },
                'world': state.currentWorld,
                'water': state.water,
                'timestamp': state.timestamp
            }
            self.debug_logger.debug(f"Frame logged: {json.dumps(debug_data)}")
        else:
            error_msg = "Error: Log file is not open."
            print(error_msg, flush=True)
            self.debug_logger.error(error_msg)

    def log_position_update(self, position_data):
        """Log position updates from JavaScript"""
        self.debug_logger.info(f"Position update received: {position_data}")
    
    def log_error(self, error):
        """Log errors"""
        self.debug_logger.error(error) 