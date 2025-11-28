"""
Python Backend WebSocket Server
Entry point for the three-maze backend system

Handles:
- WebSocket communication with frontend
- Serial port management
- Hardware control (water delivery, etc.)
- Data logging
- Experiment protocol execution
- Data replay mode for testing (--replay flag)
"""

import argparse
import asyncio
import json
import logging
import sys
import time
from typing import Dict, Any, Optional, Set
import websockets
from datetime import datetime
import os
import socket

# Configure basic logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)

logger = logging.getLogger(__name__)


def find_available_port(start_port: int = 8765, max_attempts: int = 10) -> Optional[int]:
    """
    Find an available port starting from start_port.

    Args:
        start_port: Port to start searching from
        max_attempts: Maximum number of ports to try

    Returns:
        Available port number, or None if no port found
    """
    for port in range(start_port, start_port + max_attempts):
        try:
            # Try to bind to the port
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(('localhost', port))
                # If successful, port is available
                logger.info(f"Found available port: {port}")
                return port
        except OSError:
            logger.debug(f"Port {port} is already in use, trying next...")
            continue

    return None


class BackendServer:
    """Main WebSocket server for frontend communication"""

    def __init__(self, host: str = "localhost", port: int = 8765, replay_mode: bool = False):
        self.host = host
        self.port = port
        self.replay_mode = replay_mode
        self.active_clients: Set[Any] = set()
        self.message_handlers: Dict[str, Any] = {}
        self.hardware_manager = None
        self.data_logger = None
        self.replayer = None  # DataReplayer instance if in replay mode
        self.active_experiment = None  # Active Python experiment instance
        self.autonomous_task = None  # Background task for autonomous experiments

        # Event-driven serial data queue (one queue per client)
        self.client_queues: Dict[Any, asyncio.Queue] = {}

        # NEW: Use ExperimentLoader for dynamic loading
        from backend.src.experiment_loader import ExperimentLoader
        self.experiment_loader = ExperimentLoader()

        # Initialize replayer if in replay mode
        if self.replay_mode:
            from backend.src.data_replayer import DataReplayer
            self.replayer = DataReplayer()
            logger.info("Replay mode enabled")

        # Register message handlers
        self._register_handlers()


    def _register_handlers(self):
        """Register WebSocket message type handlers"""
        self.message_handlers = {
            "ping": self._handle_ping,
            "connect": self._handle_connect,
            "disconnect": self._handle_disconnect,
            "serial_init": self._handle_serial_init,
            "serial_close": self._handle_serial_close,
            "water_deliver": self._handle_water_deliver,
            "logging_start": self._handle_logging_start,
            "logging_write": self._handle_logging_write,
            "logging_stop": self._handle_logging_stop,
            "experiment_start": self._handle_experiment_start,
            "experiment_stop": self._handle_experiment_stop,
            "status_request": self._handle_status_request,
            # Replay mode handlers
            "replay_load": self._handle_replay_load,
            "replay_play": self._handle_replay_play,
            "replay_pause": self._handle_replay_pause,
            "replay_stop": self._handle_replay_stop,
            "replay_seek": self._handle_replay_seek,
            "replay_set_speed": self._handle_replay_set_speed,
            "replay_toggle_loop": self._handle_replay_toggle_loop,
            "replay_status": self._handle_replay_status,
            # Python experiment handlers
            "experiment_register": self._handle_experiment_register,
            "experiment_list": self._handle_experiment_list,
            "experiment_unregister": self._handle_experiment_unregister,
            "position_update": self._handle_position_update,
        }

    async def _handle_ping(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle ping message"""
        return {
            "type": "pong",
            "timestamp": time.time() * 1000
        }

    async def _handle_connect(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle client connection"""
        logger.info(f"Client connected: {data.get('clientId', 'unknown')}")

        # Initialize hardware manager on first connection
        if self.hardware_manager is None:
            from backend.src.hardware.hardware_base import HardwareManager
            self.hardware_manager = HardwareManager()

        return {
            "type": "connected",
            "data": {
                "serverId": "python-backend",
                "version": "1.0.0",
                "capabilities": ["serial", "water-delivery", "data-logging"],
                "timestamp": time.time() * 1000
            }
        }

    async def _handle_disconnect(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle client disconnect"""
        logger.info(f"Client disconnect requested: {data.get('reason', 'unknown')}")
        return {
            "type": "disconnected",
            "data": {"acknowledged": True}
        }

    async def _handle_serial_init(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle serial port initialization"""
        try:
            # If in replay mode, fake serial initialization
            if self.replay_mode:
                logger.info("Replay mode: Simulating serial initialization")
                return {
                    "type": "serial_initialized",
                    "data": {
                        "port": "REPLAY_MODE",
                        "status": "simulated",
                        "handle": "replay_serial_001"
                    }
                }

            # Normal serial initialization
            if self.hardware_manager is None:
                from backend.src.hardware.hardware_base import HardwareManager
                self.hardware_manager = HardwareManager()

            port = data.get("port", "COM5")
            baudrate = data.get("baudRate", 115200)

            # Set up event-driven callback for serial data
            result = await self.hardware_manager.initialize_serial(
                port,
                baudrate,
                data_callback=self._on_serial_data_received
            )

            if result.get("success"):
                return {
                    "type": "serial_initialized",
                    "data": {
                        "port": port,
                        "status": "open",
                        "handle": result.get("handle", "serial_001")
                    }
                }
            else:
                return {
                    "type": "serial_error",
                    "data": {
                        "error": result.get("error", "Unknown error"),
                        "code": "SERIAL_INIT_FAILED"
                    }
                }
        except Exception as e:
            logger.error(f"Serial init error: {e}")
            return {
                "type": "serial_error",
                "data": {
                    "error": str(e),
                    "code": "SERIAL_INIT_EXCEPTION"
                }
            }

    async def _handle_serial_close(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle serial port close"""
        try:
            if self.hardware_manager:
                await self.hardware_manager.close_serial()

            return {
                "type": "serial_closed",
                "data": {"status": "closed"}
            }
        except Exception as e:
            logger.error(f"Serial close error: {e}")
            return {
                "type": "error",
                "data": {"error": str(e), "code": "SERIAL_CLOSE_FAILED"}
            }

    async def _handle_water_deliver(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle water delivery"""
        try:
            if self.hardware_manager is None:
                return {
                    "type": "water_error",
                    "data": {"error": "Hardware manager not initialized"}
                }

            amount = data.get("amount", 1)
            duration = data.get("duration", 25)

            result = await self.hardware_manager.deliver_water(amount, duration)

            if result.get("success"):
                return {
                    "type": "water_delivered",
                    "data": result
                }
            else:
                return {
                    "type": "water_error",
                    "data": result
                }
        except Exception as e:
            logger.error(f"Water delivery error: {e}")
            return {
                "type": "water_error",
                "data": {"error": str(e), "code": "WATER_DELIVERY_FAILED"}
            }

    async def _handle_logging_start(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle logging start"""
        try:
            if self.data_logger is None:
                from backend.src.utils.data_logger import DataLogger
                self.data_logger = DataLogger()

            filename = data.get("filename", f"experiment_{int(time.time())}.tsv")
            format_type = data.get("format", "tsv")

            result = await self.data_logger.start_logging(filename, format_type)

            return {
                "type": "logging_started" if result.get("success") else "logging_error",
                "data": result
            }
        except Exception as e:
            logger.error(f"Logging start error: {e}")
            return {
                "type": "logging_error",
                "data": {"error": str(e)}
            }

    async def _handle_logging_write(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle log entry write"""
        try:
            if self.data_logger and self.data_logger.is_active:
                entry = data.get("entry", {})
                await self.data_logger.log_entry(entry)

                return {
                    "type": "logging_written",
                    "data": {"success": True}
                }
            else:
                return {
                    "type": "logging_error",
                    "data": {"error": "Logger not active"}
                }
        except Exception as e:
            logger.error(f"Logging write error: {e}")
            return {
                "type": "logging_error",
                "data": {"error": str(e)}
            }

    async def _handle_logging_stop(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle logging stop"""
        try:
            if self.data_logger:
                result = await self.data_logger.stop_logging()
                return {
                    "type": "logging_stopped",
                    "data": result
                }
            else:
                return {
                    "type": "logging_error",
                    "data": {"error": "No active logger"}
                }
        except Exception as e:
            logger.error(f"Logging stop error: {e}")
            return {
                "type": "logging_error",
                "data": {"error": str(e)}
            }

    async def _handle_experiment_start(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle experiment start"""
        experiment_id = data.get("experimentId", "unknown")
        logger.info(f"Experiment started: {experiment_id}")

        return {
            "type": "experiment_started",
            "data": {
                "experimentId": experiment_id,
                "sessionId": f"session_{int(time.time())}",
                "startTime": time.time() * 1000
            }
        }

    async def _handle_experiment_stop(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle experiment stop"""
        experiment_id = data.get("experimentId", "unknown")
        logger.info(f"Experiment stopped: {experiment_id}")

        # If Python experiment is active, terminate it
        if self.active_experiment:
            try:
                summary = await self.active_experiment.terminate()
                self.active_experiment = None
                logger.info(f"Python experiment terminated: {summary}")
            except Exception as e:
                logger.error(f"Error terminating Python experiment: {e}")

        return {
            "type": "experiment_stopped",
            "data": {
                "experimentId": experiment_id,
                "timestamp": time.time() * 1000
            }
        }

    async def _handle_experiment_register(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle Python experiment registration with dynamic loading.

        NEW: Experiments are loaded dynamically from experiments/ folder.
        No manual registration needed!

        Supports two hardware management modes:
        1. MANAGED: Backend provides shared hardware_manager
        2. AUTONOMOUS: Experiment manages its own hardware
        """
        try:
            # NEW: Accept either experimentId (old) or filename (new)
            experiment_id = data.get("experimentId")
            filename = data.get("filename")  # NEW: filename from UI
            config = data.get("config", {})

            if not experiment_id and not filename:
                return {
                    "type": "experiment_error",
                    "data": {"error": "No experiment ID or filename provided"}
                }

            # Check if another experiment is already active
            if self.active_experiment is not None:
                return {
                    "type": "experiment_error",
                    "data": {
                        "error": "Another experiment is already active",
                        "activeExperiment": getattr(self.active_experiment, 'experiment_id', 'unknown')
                    }
                }

            # NEW: If filename provided, use dynamic loading
            if filename:
                logger.info(f"Loading experiment from file: {filename}")

                try:
                    # Determine hardware mode from config or default to managed
                    requested_mode = config.get('hardwareMode', 'managed')

                    # Load experiment class dynamically
                    ExperimentClass = self.experiment_loader.load_experiment(filename, requested_mode)

                    # Use filename (without .py) as experiment_id
                    experiment_id = filename.replace('.py', '')

                except FileNotFoundError:
                    available = self.experiment_loader.get_available_experiments()
                    return {
                        "type": "experiment_error",
                        "data": {
                            "error": f"Experiment file not found: {filename}",
                            "available": available
                        }
                    }
                except Exception as e:
                    return {
                        "type": "experiment_error",
                        "data": {"error": f"Failed to load experiment: {str(e)}"}
                    }

            # OLD: Backward compatibility - experiment_id for pre-registered experiments
            else:
                logger.warning(f"Using deprecated experiment_id: {experiment_id}")
                # For backward compatibility, map old IDs to filenames
                id_to_file = {
                    "hallway02": "hallway_experiment.py",
                    "hallway_python": "hallway_experiment.py",
                    "autonomous_hallway": "autonomous_hallway_experiment.py"
                }

                filename = id_to_file.get(experiment_id)
                if not filename:
                    return {
                        "type": "experiment_error",
                        "data": {"error": f"Unknown experiment ID: {experiment_id}"}
                    }

                ExperimentClass = self.experiment_loader.load_experiment(filename, 'managed')

            # Get hardware mode from class
            hardware_mode = getattr(ExperimentClass, 'HARDWARE_MODE', 'managed')

            logger.info(f"Registering experiment: {experiment_id} (mode: {hardware_mode})")

            # === MANAGED MODE ===
            if hardware_mode == 'managed':
                # Initialize hardware manager if needed
                if self.hardware_manager is None:
                    from backend.src.hardware.hardware_base import HardwareManager
                    self.hardware_manager = HardwareManager()
                    logger.info("Initialized shared hardware manager")

                # Create experiment with hardware_manager
                self.active_experiment = ExperimentClass(
                    experiment_id=experiment_id,
                    config=config,
                    hardware_manager=self.hardware_manager
                )

                logger.info(f"Created managed experiment: {experiment_id}")

            # === AUTONOMOUS MODE ===
            elif hardware_mode == 'autonomous':
                # Create event callback for autonomous experiments
                async def autonomous_event_callback(event_type: str, data: dict):
                    """
                    Event callback for autonomous experiments.
                    Allows experiments to push data events directly to clients.
                    """
                    if 'timestamp' not in data:
                        data['timestamp'] = time.time() * 1000

                    message_data = {
                        "type": event_type,
                        "data": data,
                        "timestamp": time.time() * 1000
                    }

                    # Push to all client queues
                    for queue in self.client_queues.values():
                        try:
                            queue.put_nowait(message_data)
                        except asyncio.QueueFull:
                            logger.warning(f"Client queue full, dropping {event_type} event")

                # Create experiment with event_callback
                self.active_experiment = ExperimentClass(
                    experiment_id=experiment_id,
                    config=config,
                    hardware_manager=None,
                    event_callback=autonomous_event_callback
                )

                logger.info(f"Created autonomous experiment with event callback: {experiment_id}")

            # === STANDALONE MODE ===
            elif hardware_mode == 'standalone':
                # Create event callback for standalone experiments
                async def standalone_event_callback(event_type: str, data: dict):
                    """
                    Event callback for standalone experiments.
                    Allows experiments to push data events directly to clients.
                    """
                    if 'timestamp' not in data:
                        data['timestamp'] = time.time() * 1000

                    message_data = {
                        "type": event_type,
                        "data": data,
                        "timestamp": time.time() * 1000
                    }

                    # Push to all client queues
                    for queue in self.client_queues.values():
                        try:
                            queue.put_nowait(message_data)
                        except asyncio.QueueFull:
                            logger.warning(f"Client queue full, dropping {event_type} event")

                # Create experiment with event_callback
                self.active_experiment = ExperimentClass(
                    experiment_id=experiment_id,
                    config=config,
                    hardware_manager=None,
                    event_callback=standalone_event_callback
                )

                logger.info(f"Created standalone experiment with event callback: {experiment_id}")

            else:
                return {
                    "type": "experiment_error",
                    "data": {"error": f"Unknown hardware mode: {hardware_mode}"}
                }

            # Initialize experiment
            initial_state = await self.active_experiment.initialize(config)

            logger.info(f"Experiment initialized successfully: {experiment_id}")

            # Start background loop for autonomous/standalone experiments
            # This loop broadcasts experiment state (including serial_connected status)
            # to frontend at regular intervals
            if hardware_mode in ['autonomous', 'standalone']:
                self.autonomous_task = asyncio.create_task(self.autonomous_experiment_loop())
                logger.info(f"Started autonomous experiment loop for {hardware_mode} mode")

            return {
                "type": "experiment_registered",
                "data": {
                    "experimentId": experiment_id,
                    "filename": filename,
                    "hardwareMode": hardware_mode,
                    "state": initial_state,
                    "timestamp": time.time() * 1000
                }
            }

        except Exception as e:
            logger.error(f"Error registering experiment: {e}", exc_info=True)
            # Cleanup if initialization failed
            if self.autonomous_task:
                self.autonomous_task.cancel()
                try:
                    await self.autonomous_task
                except asyncio.CancelledError:
                    pass
                self.autonomous_task = None
            if self.active_experiment is not None:
                try:
                    await self.active_experiment.terminate()
                except:
                    pass
                self.active_experiment = None
            return {
                "type": "experiment_error",
                "data": {"error": str(e)}
            }

    async def _handle_experiment_list(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle request for available Python experiments"""
        return {
            "type": "experiment_list",
            "data": {
                "experiments": list(self.experiment_registry.keys()),
                "active": self.active_experiment.experiment_id if self.active_experiment else None
            }
        }

    async def _handle_experiment_unregister(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle Python experiment unregistration"""
        if self.active_experiment:
            try:
                # Stop autonomous task if running
                if self.autonomous_task:
                    self.autonomous_task.cancel()
                    try:
                        await self.autonomous_task
                    except asyncio.CancelledError:
                        pass
                    self.autonomous_task = None
                    logger.info("Stopped autonomous experiment background loop")

                summary = await self.active_experiment.terminate()
                experiment_id = self.active_experiment.experiment_id
                self.active_experiment = None

                logger.info(f"Python experiment unregistered: {experiment_id}")

                return {
                    "type": "experiment_unregistered",
                    "data": {
                        "experimentId": experiment_id,
                        "summary": summary
                    }
                }
            except Exception as e:
                logger.error(f"Error unregistering experiment: {e}")
                return {
                    "type": "experiment_error",
                    "data": {"error": str(e)}
                }
        else:
            return {
                "type": "experiment_error",
                "data": {"error": "No active Python experiment"}
            }

    async def _handle_position_update(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle position update from frontend physics engine"""
        if self.active_experiment and hasattr(self.active_experiment, 'process_position_update'):
            # Pass position to experiment and get response position
            response_position = await self.active_experiment.process_position_update(data)

            return {
                "type": "position_confirm",
                "data": response_position
            }
        else:
            # No experiment active, echo back the position
            return {
                "type": "position_confirm",
                "data": {
                    "x": data.get("x", 0),
                    "y": data.get("y", 0),
                    "z": data.get("z", 0),
                    "theta": data.get("theta", 0)
                }
            }

    async def _handle_status_request(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle status request"""
        hardware_status = {}
        if self.hardware_manager:
            hardware_status = await self.hardware_manager.get_status()

        return {
            "type": "status_response",
            "data": {
                "system": {
                    "uptime": time.time() * 1000,
                    "clients": len(self.active_clients),
                    "replay_mode": self.replay_mode
                },
                "hardware": hardware_status
            }
        }

    # Replay mode handlers
    async def _handle_replay_load(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle replay file load"""
        if not self.replay_mode or not self.replayer:
            return {"type": "error", "data": {"error": "Not in replay mode"}}

        filepath = data.get("filepath")
        if not filepath:
            return {"type": "error", "data": {"error": "No filepath provided"}}

        success = self.replayer.load_file(filepath)
        return {
            "type": "replay_loaded" if success else "replay_error",
            "data": {"filepath": filepath, "success": success}
        }

    async def _handle_replay_play(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle replay play"""
        if self.replayer:
            self.replayer.play()
        return {"type": "replay_playing", "data": {}}

    async def _handle_replay_pause(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle replay pause"""
        if self.replayer:
            self.replayer.pause()
        return {"type": "replay_paused", "data": {}}

    async def _handle_replay_stop(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle replay stop"""
        if self.replayer:
            self.replayer.stop()
        return {"type": "replay_stopped", "data": {}}

    async def _handle_replay_seek(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle replay seek"""
        if self.replayer:
            frames = data.get("frames", 0)
            self.replayer.seek(frames)
        return {"type": "replay_seeked", "data": {}}

    async def _handle_replay_set_speed(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle replay speed change"""
        if self.replayer:
            speed = data.get("speed", 1.0)
            self.replayer.set_speed(speed)
        return {"type": "replay_speed_changed", "data": {"speed": self.replayer.speed}}

    async def _handle_replay_toggle_loop(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle replay loop toggle"""
        if self.replayer:
            self.replayer.toggle_loop()
        return {"type": "replay_loop_toggled", "data": {"looping": self.replayer.is_looping}}

    async def _handle_replay_status(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Handle replay status request"""
        if self.replayer:
            status = self.replayer.get_status()
            return {"type": "replay_status", "data": status}
        return {"type": "error", "data": {"error": "No replayer available"}}

    async def handle_message(self, websocket: Any, message: str):
        """Handle incoming message from client"""
        try:
            data = json.loads(message)
            msg_type = data.get("type")
            request_id = data.get("requestId")

            logger.debug(f"Received message type: {msg_type}")

            if msg_type in self.message_handlers:
                handler = self.message_handlers[msg_type]
                response = await handler(data.get("data", {}))

                # Add request ID if present
                if request_id:
                    response["requestId"] = request_id

                # Add timestamp
                response["timestamp"] = time.time() * 1000

                await websocket.send(json.dumps(response))
            else:
                logger.warning(f"Unknown message type: {msg_type}")
                await websocket.send(json.dumps({
                    "type": "error",
                    "data": {
                        "code": "UNKNOWN_MESSAGE_TYPE",
                        "message": f"Unknown message type: {msg_type}"
                    },
                    "requestId": request_id,
                    "timestamp": time.time() * 1000
                }))

        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON: {e}")
            await websocket.send(json.dumps({
                "type": "error",
                "data": {
                    "code": "INVALID_JSON",
                    "message": "Failed to parse JSON"
                },
                "timestamp": time.time() * 1000
            }))

        except Exception as e:
            logger.error(f"Error handling message: {e}")
            await websocket.send(json.dumps({
                "type": "error",
                "data": {
                    "code": "INTERNAL_ERROR",
                    "message": str(e)
                },
                "timestamp": time.time() * 1000
            }))

    async def autonomous_experiment_loop(self):
        """
        Background loop for autonomous and standalone experiments.

        Periodically calls experiment.process_serial_data(None) and broadcasts
        the updated state to all connected clients.

        Autonomous and standalone experiments manage their own serial ports,
        so they don't need serial data from the backend. They return their state directly.
        """
        logger.info("Starting autonomous experiment loop")

        while self.active_experiment and self.active_experiment.HARDWARE_MODE in ['autonomous', 'standalone']:
            try:
                # Call experiment's process_serial_data (it reads its own serial)
                experiment_state = await self.active_experiment.process_serial_data(None)

                if experiment_state:
                    # Broadcast state to all connected clients
                    message = {
                        "type": "experiment_state",
                        "data": experiment_state,
                        "timestamp": time.time() * 1000
                    }
                    message_json = json.dumps(message)

                    # Send to all clients (use list() to avoid "Set changed size during iteration")
                    disconnected_clients = []
                    for client in list(self.active_clients):
                        try:
                            await client.send(message_json)
                        except Exception as e:
                            logger.error(f"Failed to send to client: {e}")
                            disconnected_clients.append(client)

                    # Remove disconnected clients
                    for client in disconnected_clients:
                        self.active_clients.discard(client)

                # Run at ~50 Hz (matching the experiment's DT = 1/20 = 50ms, but we poll faster)
                await asyncio.sleep(0.02)  # 20ms = 50Hz

            except Exception as e:
                logger.error(f"Error in autonomous experiment loop: {e}", exc_info=True)
                await asyncio.sleep(0.1)  # Slow down on error

        logger.info("Autonomous experiment loop stopped")

    async def _on_serial_data_received(self, serial_data: Dict[str, Any]):
        """
        Callback invoked when serial data is received (event-driven).
        Pushes data to all connected client queues.
        """
        # Add timestamp if not present
        if 'timestamp' not in serial_data:
            serial_data['timestamp'] = time.time() * 1000

        # If Python experiment is active, process data through it
        if self.active_experiment:
            try:
                experiment_state = await self.active_experiment.process_serial_data(serial_data)

                if experiment_state:
                    # Push experiment state to all client queues
                    message_data = {
                        "type": "experiment_state",
                        "data": experiment_state,
                        "timestamp": time.time() * 1000
                    }

                    for queue in self.client_queues.values():
                        try:
                            queue.put_nowait(message_data)
                        except asyncio.QueueFull:
                            logger.warning("Client queue full, dropping data")
                    return
            except Exception as e:
                logger.error(f"Error processing serial data in experiment: {e}")
                # Fall through to send raw data

        # No experiment or experiment processing failed - send raw serial data
        message_data = {
            "type": "serial_data",
            "data": serial_data,
            "timestamp": serial_data.get('timestamp', time.time() * 1000)
        }

        # Push to all client queues
        for queue in self.client_queues.values():
            try:
                queue.put_nowait(message_data)
            except asyncio.QueueFull:
                logger.warning("Client queue full, dropping data")

    async def serial_data_streamer(self, websocket: Any):
        """
        Event-driven serial data streamer.

        Waits for data from the client's queue (populated by serial data callback)
        and sends it to the WebSocket client immediately.

        Note: This is only for MANAGED mode experiments. AUTONOMOUS experiments use
        autonomous_experiment_loop() instead.
        """
        # Create a queue for this client
        client_queue = asyncio.Queue(maxsize=1000)  # Buffer up to 1000 messages
        self.client_queues[websocket] = client_queue

        logger.info(f"Started event-driven serial data streamer for client")

        try:
            while websocket in self.active_clients:
                try:
                    # In replay mode, use replayer with polling
                    if self.replay_mode and self.replayer:
                        serial_data = await self.replayer.get_next_frame()

                        if serial_data:
                            # Process through experiment if active
                            if self.active_experiment:
                                try:
                                    experiment_state = await self.active_experiment.process_serial_data(serial_data)
                                    if experiment_state:
                                        message = {
                                            "type": "experiment_state",
                                            "data": experiment_state,
                                            "timestamp": time.time() * 1000
                                        }
                                        await websocket.send(json.dumps(message))
                                except Exception as e:
                                    logger.error(f"Error processing replay data in experiment: {e}")
                            else:
                                message = {
                                    "type": "serial_data",
                                    "data": serial_data,
                                    "timestamp": time.time() * 1000
                                }
                                await websocket.send(json.dumps(message))
                    else:
                        # Event-driven mode: wait for data from queue
                        message_data = await client_queue.get()
                        await websocket.send(json.dumps(message_data))

                except Exception as e:
                    logger.error(f"Error streaming serial data: {e}")
                    await asyncio.sleep(0.1)  # Slow down on error
        finally:
            # Cleanup: remove client queue
            if websocket in self.client_queues:
                del self.client_queues[websocket]
                logger.info(f"Removed client queue")

    async def handle_client(self, websocket: Any):
        """Handle client connection"""
        client_id = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
        logger.info(f"Client connected: {client_id}")

        self.active_clients.add(websocket)

        # Start serial data streaming task
        serial_task = asyncio.create_task(self.serial_data_streamer(websocket))

        try:
            async for message in websocket:
                await self.handle_message(websocket, message)

        except websockets.exceptions.ConnectionClosed:
            logger.info(f"Client disconnected: {client_id}")

        finally:
            self.active_clients.remove(websocket)
            serial_task.cancel()

            # Cleanup if last client disconnected
            if len(self.active_clients) == 0:
                logger.info("No active clients, cleaning up hardware")

                # Clean up autonomous experiment (CRITICAL!)
                if self.active_experiment:
                    logger.info("Cleaning up active experiment due to client disconnect")
                    try:
                        # Stop autonomous task if running
                        if self.autonomous_task:
                            self.autonomous_task.cancel()
                            try:
                                await self.autonomous_task
                            except asyncio.CancelledError:
                                pass
                            self.autonomous_task = None
                            logger.info("Stopped autonomous experiment background loop")

                        # Terminate experiment
                        summary = await self.active_experiment.terminate()
                        experiment_id = self.active_experiment.experiment_id
                        self.active_experiment = None
                        logger.info(f"Experiment terminated: {experiment_id}")
                        logger.info(f"Experiment summary: {summary}")
                    except Exception as e:
                        logger.error(f"Error terminating experiment during cleanup: {e}", exc_info=True)

                # Clean up shared hardware
                if self.hardware_manager:
                    await self.hardware_manager.cleanup()
                if self.data_logger:
                    await self.data_logger.stop_logging()

    async def start(self):
        """Start the WebSocket server with automatic port selection"""
        # Try to find an available port starting from the configured port
        available_port = find_available_port(self.port)

        if available_port is None:
            logger.error(f"Could not find available port starting from {self.port}")
            raise RuntimeError(f"No available ports found (tried {self.port}-{self.port + 9})")

        # Update port if different from configured
        if available_port != self.port:
            logger.warning(f"Port {self.port} is in use, using port {available_port} instead")
            self.port = available_port

        logger.info(f"Starting WebSocket server on ws://{self.host}:{self.port}")

        async with websockets.serve(self.handle_client, self.host, self.port):
            # Print clear success message with port info for start-dev.js to parse
            logger.info("=" * 60)
            logger.info(f"WebSocket server ready on port {self.port}")
            logger.info(f"  -> ws://{self.host}:{self.port}")
            logger.info("=" * 60)
            logger.info("Waiting for client connections...")

            # If in replay mode, start web dashboard
            if self.replay_mode and self.replayer:
                from backend.src.replay_dashboard import ReplayDashboard
                dashboard = ReplayDashboard(self.replayer, host='localhost', port=8766)
                dashboard.start()
                logger.info("=" * 60)
                logger.info("Replay Dashboard: http://localhost:8766")
                logger.info("Open this URL in your browser to control playback")
                logger.info("=" * 60)

            await asyncio.Future()  # Run forever


def main():
    """Main entry point"""
    # Parse command-line arguments
    parser = argparse.ArgumentParser(
        description="Three-Maze Python Backend Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  Normal mode (with hardware):
    python -m backend.src.main

  Replay mode (with data file):
    python -m backend.src.main --replay --file "path/to/data.txt"

  Replay mode (load file later via TUI):
    python -m backend.src.main --replay
        """
    )
    parser.add_argument(
        '--replay',
        action='store_true',
        help='Start in replay mode (simulates hardware with recorded data)'
    )
    parser.add_argument(
        '--file',
        type=str,
        help='Data file to load in replay mode'
    )

    args = parser.parse_args()

    try:
        # Create server
        server = BackendServer(host="localhost", port=8765, replay_mode=args.replay)

        # Load file if specified
        if args.replay and args.file and server.replayer:
            if server.replayer.load_file(args.file):
                logger.info(f"Loaded replay file: {args.file}")
            else:
                logger.error(f"Failed to load replay file: {args.file}")

        # Start server
        asyncio.run(server.start())

    except KeyboardInterrupt:
        logger.info("Server stopped by user")
    except Exception as e:
        logger.error(f"Server error: {e}")
        raise


if __name__ == "__main__":
    main()
