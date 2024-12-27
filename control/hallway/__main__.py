import sys
import json
import time
import traceback
import msvcrt  # Windows-specific module for console input
from control.hallway.controller import HallwayController

def main():
    baudrate = int(sys.argv[1]) if len(sys.argv) > 1 else 115200
    
    try:
        controller = HallwayController()
        controller.initialize()
        running = True
        
        while running:
            # Check for input using msvcrt on Windows
            if msvcrt.kbhit():
                line = sys.stdin.readline()
                if line:
                    try:
                        command = json.loads(line)
                        if command.get('command') == 'stop_logging':
                            controller.stop_logging()
                            running = False
                            break
                    except json.JSONDecodeError:
                        print(json.dumps({"error": "Invalid command format"}), flush=True)
            
            # Regular data processing
            data = controller.update()
            if data:
                print(json.dumps(data), flush=True)
            time.sleep(1/60)
            
        # Clean up before exiting
        controller.termination()
        sys.exit(0)
            
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