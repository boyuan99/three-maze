"""Base class for all hardware components"""
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional
import asyncio
import logging

logger = logging.getLogger(__name__)


class HardwareBase(ABC):
    """Abstract base class for hardware components"""

    def __init__(self, name: str):
        self.name = name
        self.is_initialized = False
        self.is_active = False
        self.error_count = 0
        self.last_error: Optional[str] = None

    @abstractmethod
    async def initialize(self, config: Dict[str, Any]) -> bool:
        """
        Initialize hardware with given configuration

        Args:
            config: Hardware-specific configuration dictionary

        Returns:
            True if initialization successful, False otherwise
        """
        pass

    @abstractmethod
    async def start(self) -> bool:
        """
        Start hardware operation

        Returns:
            True if started successfully, False otherwise
        """
        pass

    @abstractmethod
    async def stop(self) -> bool:
        """
        Stop hardware operation

        Returns:
            True if stopped successfully, False otherwise
        """
        pass

    @abstractmethod
    async def cleanup(self) -> bool:
        """
        Cleanup hardware resources

        Returns:
            True if cleanup successful, False otherwise
        """
        pass

    async def get_status(self) -> Dict[str, Any]:
        """Get hardware status"""
        return {
            'name': self.name,
            'initialized': self.is_initialized,
            'active': self.is_active,
            'error_count': self.error_count,
            'last_error': self.last_error
        }


class HardwareManager:
    """
    Manages all hardware components for the backend system
    Coordinates serial port, water delivery, and other hardware
    """

    def __init__(self):
        self.serial_manager = None
        self.water_delivery = None
        self.is_initialized = False

    async def initialize_serial(self, port: str, baudrate: int = 115200, data_callback=None) -> Dict[str, Any]:
        """Initialize serial port with optional data callback"""
        try:
            if self.serial_manager is None:
                from backend.src.hardware.serial_manager import SerialManager
                self.serial_manager = SerialManager()

            # Set data callback if provided (for event-driven mode)
            if data_callback:
                self.serial_manager.set_data_callback(data_callback)

            config = {
                'port': port,
                'baudRate': baudrate
            }

            success = await self.serial_manager.initialize(config)

            if success:
                await self.serial_manager.start()
                return {
                    'success': True,
                    'handle': 'serial_001',
                    'port': port,
                    'baudrate': baudrate
                }
            else:
                return {
                    'success': False,
                    'error': self.serial_manager.last_error or 'Unknown error'
                }

        except Exception as e:
            logger.error(f"Failed to initialize serial: {e}")
            return {
                'success': False,
                'error': str(e)
            }

    async def close_serial(self) -> Dict[str, Any]:
        """Close serial port"""
        try:
            if self.serial_manager:
                await self.serial_manager.cleanup()
                return {'success': True}
            return {'success': True, 'message': 'Serial not initialized'}

        except Exception as e:
            logger.error(f"Failed to close serial: {e}")
            return {
                'success': False,
                'error': str(e)
            }

    async def read_serial_data(self) -> Optional[Dict[str, Any]]:
        """Read serial data if available"""
        if self.serial_manager and self.serial_manager.is_active:
            return await self.serial_manager.get_latest_data()
        return None

    async def deliver_water(self, amount: int = 1, duration: int = 25) -> Dict[str, Any]:
        """Deliver water reward"""
        try:
            if self.water_delivery is None:
                from backend.src.hardware.water_delivery import WaterDelivery
                self.water_delivery = WaterDelivery()

                # Initialize if not already initialized
                if not self.water_delivery.is_initialized:
                    config = {
                        'device': 'Dev1',
                        'channel': 'ao0',
                        'voltage': 5.0,
                        'duration': duration,
                        'cooldown': 1000
                    }
                    await self.water_delivery.initialize(config)
                    await self.water_delivery.start()

            result = await self.water_delivery.deliver(amount)
            return result

        except Exception as e:
            logger.error(f"Failed to deliver water: {e}")
            return {
                'success': False,
                'error': str(e)
            }

    async def get_status(self) -> Dict[str, Any]:
        """Get status of all hardware components"""
        status = {}

        if self.serial_manager:
            status['serial'] = await self.serial_manager.get_status()

        if self.water_delivery:
            status['water_delivery'] = await self.water_delivery.get_status()

        return status

    async def cleanup(self):
        """Cleanup all hardware resources"""
        logger.info("Cleaning up hardware manager...")

        if self.serial_manager:
            await self.serial_manager.cleanup()
            self.serial_manager = None

        if self.water_delivery:
            await self.water_delivery.cleanup()
            self.water_delivery = None

        self.is_initialized = False
        logger.info("Hardware cleanup complete")
