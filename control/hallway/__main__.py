import sys
import json
import time
from .controller import HallwayController

def main():
    # Get baudrate from command line args if provided
    baudrate = int(sys.argv[1]) if len(sys.argv) > 1 else 115200
    
    try:
        controller = HallwayController()
        controller.initialize()
        
        while True:
            data = controller.update()
            if data:
                # Print JSON data for Electron IPC
                print(json.dumps(data), flush=True)
            time.sleep(1/60)  # 60Hz update rate
            
    except KeyboardInterrupt:
        controller.termination()
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main() 