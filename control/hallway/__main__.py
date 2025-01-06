import sys
import json
import time
import traceback
import msvcrt
from control.hallway.controller import HallwayController
from control.utils.ipc import IpcHandler

def main():
    baudrate = int(sys.argv[1]) if len(sys.argv) > 1 else 115200
    ipc = IpcHandler()
    
    try:
        controller = HallwayController()
        controller.initialize()
        ipc.debug("Controller initialized")
        running = True
        
        while running:
            if msvcrt.kbhit():
                line = sys.stdin.readline()
                if line:
                    try:
                        command = json.loads(line)
                        if command.get('command') == 'stop_logging':
                            controller.stop_logging()
                            ipc.send("status", "stopping")
                            running = False
                            break
                    except json.JSONDecodeError:
                        ipc.send("error", "Invalid command format")
            
            # Regular data processing
            data = controller.update()
            if data:
                ipc.send("serial_data", data)
            time.sleep(1/60)
            
        # Clean up before exiting
        controller.termination()
        ipc.send("status", "terminated")
        sys.exit(0)
            
    except KeyboardInterrupt:
        ipc.send("status", "interrupted")
        controller.termination()
    except Exception as e:
        error_details = {
            "message": str(e),
            "traceback": traceback.format_exc()
        }
        ipc.send("error", error_details)
        sys.exit(1)

if __name__ == "__main__":
    main() 