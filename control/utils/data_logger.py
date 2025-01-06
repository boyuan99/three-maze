import datetime
import os

class DataLogger:
    def __init__(self):
        self.file = None
        
    def start_new_session(self):
        timestamp = datetime.datetime.now().strftime("%d-%m-%Y-%H-%M-%S-%a")
        filepath = os.path.join("D:", "VirmenData", f"{timestamp}-timedata-simplified.txt")
        
        # Create directory if it doesn't exist
        os.makedirs(os.path.join("D:", "VirmenData"), exist_ok=True)
        
        try:
            self.file = open(filepath, 'w')
            print(f"Successfully opened log file: {filepath}", flush=True)
        except Exception as e:
            print(f"Failed to open log file: {e}", flush=True)
        
    def log_frame(self, state, serial_data):
        position = serial_data

        data_line = (
            f"{position['x']}\t{position['y']}\t{position['theta']}\t"
            f"{state.currentWorld}\t{state.water}\t{state.timestamp}\n"
        )
        if self.file is not None:
            self.file.write(data_line)
            self.file.flush()  # Ensure data is written to disk
        else:
            print("Error: Log file is not open.", flush=True) 