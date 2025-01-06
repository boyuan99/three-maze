import asyncio
import json
from control.hallway.controller import HallwayController
from control.utils.ipc import IpcHandler
import websockets

async def handle_connection(websocket):
    ipc = IpcHandler()
    controller = HallwayController()
    controller.initialize()
    ipc.debug("Controller initialized")

    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=0.016)
                ipc.debug(f"Received raw message: {message}")
                
                try:
                    if isinstance(message, str):
                        command = json.loads(message)
                        ipc.debug(f"Parsed JSON: {type(command)} - {command}") 
                    else:
                        command = message
                        ipc.debug(f"Non-string message: {type(command)} - {command}") 
                    
                    if not isinstance(command, dict):
                        raise ValueError(f"Command must be a dictionary, got {type(command)}")
                        
                except json.JSONDecodeError as e:
                    ipc.debug(f"JSON parsing error: {str(e)} for message: {message}")
                    continue
                except ValueError as e:
                    ipc.debug(f"Invalid command format: {str(e)}")
                    continue
                
                # Process valid commands
                if command.get('command') == 'stop_logging':
                    controller.stop_logging()
                    await websocket.send(json.dumps({"type": "status", "data": "stopping"}))
                    break
                elif command.get('command') == 'position_update':
                    controller.update_position(command.get('data', {}))
                    
            except asyncio.TimeoutError:
                pass
            except websockets.exceptions.ConnectionClosed:
                ipc.debug("WebSocket connection closed")
                break
            except Exception as e:
                ipc.debug(f"Error processing command: {str(e)}")
                continue

            # Process and send serial data
            try:
                data = controller.update()
                if data:
                    await websocket.send(json.dumps({"type": "serial_data", "data": data}))
            except websockets.exceptions.ConnectionClosed:
                ipc.debug("WebSocket connection closed during send")
                break
            except Exception as e:
                ipc.debug(f"Error sending data: {str(e)}")
                continue

            await asyncio.sleep(0.016)

    except Exception as e:
        ipc.debug(f"Exception in handle_connection: {str(e)}")
    finally:
        try:
            controller.termination()
            ipc.debug("Controller terminated")
        except Exception as e:
            ipc.debug(f"Error during termination: {str(e)}")

async def main():
    async with websockets.serve(handle_connection, 'localhost', 8765):
        print("WebSocket server started on ws://localhost:8765", flush=True)
        await asyncio.Future() 

if __name__ == "__main__":
    asyncio.run(main()) 