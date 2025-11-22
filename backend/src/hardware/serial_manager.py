"""Serial port management with pyserial"""
import serial
import serial.tools.list_ports
import asyncio
from typing import Dict, Any, Optional, Callable
import logging
from backend.src.hardware.hardware_base import HardwareBase


logger = logging.getLogger(__name__)


class SerialManager(HardwareBase):
    """Manages serial port communication"""

    def __init__(self):
        super().__init__('serial')
        self.port: Optional[serial.Serial] = None
        self.port_name: Optional[str] = None
        self.baud_rate: int = 115200
        self.data_callback: Optional[Callable] = None
        self.read_task: Optional[asyncio.Task] = None
        self.latest_data: Optional[Dict[str, Any]] = None
        self.data_lock = asyncio.Lock()

        # Data rate tracking
        self.data_count = 0
        self.data_rate = 0.0
        self.last_rate_update = None

    @staticmethod
    def list_ports():
        """List all available serial ports"""
        ports = serial.tools.list_ports.comports()
        return [
            {
                'path': port.device,
                'description': port.description,
                'manufacturer': port.manufacturer or 'Unknown',
                'vid': port.vid,
                'pid': port.pid
            }
            for port in ports
        ]

    async def initialize(self, config: Dict[str, Any]) -> bool:
        """Initialize serial port"""
        try:
            self.port_name = config.get('port', 'COM3')
            self.baud_rate = config.get('baudRate', 115200)

            logger.info(f"Initializing serial port {self.port_name} at {self.baud_rate} baud")

            self.port = serial.Serial(
                port=self.port_name,
                baudrate=self.baud_rate,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=1
            )

            # Send initialization string if provided
            init_string = config.get('initString')
            if init_string:
                self.port.write(f"{init_string}\n".encode())
                await asyncio.sleep(0.1)

            self.is_initialized = True
            logger.info(f"Serial port {self.port_name} initialized successfully")
            return True

        except Exception as e:
            self.last_error = str(e)
            self.error_count += 1
            logger.error(f"Failed to initialize serial port: {e}")
            return False

    async def start(self) -> bool:
        """Start reading from serial port"""
        if not self.is_initialized:
            logger.error("Serial port not initialized")
            return False

        try:
            self.is_active = True
            self.read_task = asyncio.create_task(self._read_loop())
            logger.info("Serial port reading started")
            return True
        except Exception as e:
            self.last_error = str(e)
            self.error_count += 1
            logger.error(f"Failed to start serial reading: {e}")
            return False

    async def stop(self) -> bool:
        """Stop reading from serial port"""
        try:
            self.is_active = False
            if self.read_task:
                self.read_task.cancel()
                try:
                    await self.read_task
                except asyncio.CancelledError:
                    pass
                self.read_task = None
            logger.info("Serial port reading stopped")
            return True
        except Exception as e:
            self.last_error = str(e)
            logger.error(f"Failed to stop serial reading: {e}")
            return False

    async def cleanup(self) -> bool:
        """Cleanup serial port resources"""
        try:
            await self.stop()

            if self.port and self.port.is_open:
                self.port.close()
                self.port = None

            self.is_initialized = False
            logger.info("Serial port cleaned up")
            return True

        except Exception as e:
            self.last_error = str(e)
            logger.error(f"Failed to cleanup serial port: {e}")
            return False

    def set_data_callback(self, callback: Callable):
        """Set callback for serial data"""
        self.data_callback = callback

    async def get_latest_data(self) -> Optional[Dict[str, Any]]:
        """Get the most recent serial data"""
        async with self.data_lock:
            return self.latest_data

    async def _read_loop(self):
        """Background task to read serial data"""
        import time
        logger.info("Serial read loop started")

        # Initialize rate tracking
        self.last_rate_update = time.time()
        self.data_count = 0

        while self.is_active:
            try:
                # Read line from serial port
                if self.port and self.port.in_waiting > 0:
                    line = self.port.readline().decode('utf-8').strip()

                    if line:
                        # Create data with raw line only
                        data = {
                            'raw': line,
                            'timestamp': time.time() * 1000
                        }

                        # Store latest data
                        async with self.data_lock:
                            self.latest_data = data

                        # Update data count for rate calculation
                        self.data_count += 1

                        # Update data rate every second
                        current_time = time.time()
                        elapsed = current_time - self.last_rate_update
                        if elapsed >= 1.0:
                            self.data_rate = self.data_count / elapsed
                            self.data_count = 0
                            self.last_rate_update = current_time

                        # Call callback if set
                        if self.data_callback:
                            await self.data_callback(data)
                else:
                    # Small delay to prevent CPU spinning
                    await asyncio.sleep(0.001)

            except serial.SerialException as e:
                self.last_error = str(e)
                self.error_count += 1
                logger.error(f"Serial read error: {e}")
                await asyncio.sleep(0.1)
            except Exception as e:
                self.last_error = str(e)
                self.error_count += 1
                logger.error(f"Unexpected error in read loop: {e}")
                await asyncio.sleep(0.1)

        logger.info("Serial read loop stopped")
