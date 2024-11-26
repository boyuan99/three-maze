import sys
import json
import time
import traceback
from .controller import HallwayController

def main():
    baudrate = int(sys.argv[1]) if len(sys.argv) > 1 else 115200
    
    try:
        controller = HallwayController()
        controller.initialize()
        
        while True:
            data = controller.update()
            if data:
                print(json.dumps(data), flush=True)
            time.sleep(1/60)
            
    except KeyboardInterrupt:
        controller.termination()
    except Exception as e:
        error_details = {
            "error": str(e),
            "traceback": traceback.format_exc()
        }
        print(json.dumps(error_details), flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main() 