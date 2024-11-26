import datetime
import os

class DataLogger:
    def __init__(self):
        self.file = None
        
    def start_new_session(self):
        timestamp = datetime.datetime.now().strftime("%d-%m-%Y-%H-%M-%sss-%a")
        filepath = os.path.join("D:", "VirmenData", f"{timestamp}-timedata-simplified.txt")
        self.file = open(filepath, 'w')
        
    def log_frame(self, state, position):
        if not self.file:
            return
            
        data_line = (f"{position[0]}\t{position[1]}\t{position[3]}\t"
                    f"{state.velocity[0]}\t{state.velocity[1]}\t"
                    f"{state.water}\t{state.timestamp}\t{state.white}\n")
        self.file.write(data_line) 