import datetime
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

class DataLogger:
    def __init__(self):
        self.file = None

        # Set up debug logger
        self.log_dir = os.path.join(BASE_DIR, "logs")
        if not os.path.exists(self.log_dir):
            os.makedirs(self.log_dir)

        # Create timestamp for this session
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

        # Set up main debug logger
        debug_file = os.path.join(self.log_dir, f"debug_{timestamp}.log")
        logging.basicConfig(
            filename=debug_file,
            level=logging.DEBUG,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        self.debug_logger = logging.getLogger('hallway')

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
