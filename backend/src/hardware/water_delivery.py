"""Water delivery via NI-DAQmx"""
import asyncio
import time
from typing import Dict, Any
import logging
from backend.src.hardware.hardware_base import HardwareBase

try:
    import nidaqmx
    from nidaqmx.constants import AcquisitionType
    NIDAQMX_AVAILABLE = True
except ImportError:
    NIDAQMX_AVAILABLE = False
    logging.warning("nidaqmx not available, water delivery will be simulated")


logger = logging.getLogger(__name__)


class WaterDelivery(HardwareBase):
    """Manages water delivery via NI-DAQ"""

    def __init__(self):
        super().__init__('water_delivery')
        self.device_name = 'Dev1'
        self.channel = 'ao0'
        self.voltage = 5.0
        self.duration_ms = 25
        self.cooldown_ms = 1000
        self.last_delivery_time = 0
        self.delivery_count = 0
        self.task = None

    async def initialize(self, config: Dict[str, Any]) -> bool:
        """Initialize water delivery hardware"""
        try:
            self.device_name = config.get('device', 'Dev1')
            self.channel = config.get('channel', 'ao0')
            self.voltage = config.get('voltage', 5.0)
            self.duration_ms = config.get('duration', 25)
            self.cooldown_ms = config.get('cooldown', 1000)

            if not NIDAQMX_AVAILABLE:
                logger.warning("NI-DAQmx not available, running in simulation mode")
                self.is_initialized = True
                return True

            # Test DAQ connection
            full_channel = f"{self.device_name}/{self.channel}"
            with nidaqmx.Task() as task:
                task.ao_channels.add_ao_voltage_chan(full_channel)
                task.write(0.0)

            self.is_initialized = True
            logger.info(f"Water delivery initialized on {full_channel}")
            return True

        except Exception as e:
            self.last_error = str(e)
            self.error_count += 1
            logger.error(f"Failed to initialize water delivery: {e}")
            return False

    async def start(self) -> bool:
        """Start water delivery system"""
        self.is_active = True
        logger.info("Water delivery system active")
        return True

    async def stop(self) -> bool:
        """Stop water delivery system"""
        self.is_active = False
        logger.info("Water delivery system stopped")
        return True

    async def cleanup(self) -> bool:
        """Cleanup water delivery resources"""
        try:
            await self.stop()
            self.is_initialized = False
            logger.info("Water delivery cleaned up")
            return True
        except Exception as e:
            self.last_error = str(e)
            logger.error(f"Failed to cleanup water delivery: {e}")
            return False

    async def deliver(self, amount: int = 1) -> Dict[str, Any]:
        """
        Deliver water reward

        Args:
            amount: Number of reward pulses (default 1)

        Returns:
            Dictionary with delivery status and timing
        """
        if not self.is_initialized or not self.is_active:
            return {
                'success': False,
                'error': 'Water delivery not initialized or not active'
            }

        # Check cooldown
        current_time = time.time() * 1000
        time_since_last = current_time - self.last_delivery_time

        if time_since_last < self.cooldown_ms:
            wait_time = self.cooldown_ms - time_since_last
            return {
                'success': False,
                'error': 'Cooldown active',
                'waitTime': wait_time,
                'lastDelivery': self.last_delivery_time
            }

        try:
            start_time = time.time()

            if NIDAQMX_AVAILABLE:
                # Actual hardware delivery
                full_channel = f"{self.device_name}/{self.channel}"

                with nidaqmx.Task() as task:
                    task.ao_channels.add_ao_voltage_chan(full_channel)

                    # Pulse high
                    task.write(self.voltage)
                    await asyncio.sleep(self.duration_ms / 1000.0)

                    # Pulse low
                    task.write(0.0)
            else:
                # Simulated delivery
                logger.info(f"SIMULATED: Water delivery for {self.duration_ms}ms")
                await asyncio.sleep(self.duration_ms / 1000.0)

            actual_duration = (time.time() - start_time) * 1000
            self.last_delivery_time = current_time
            self.delivery_count += 1

            logger.info(f"Water delivered (count: {self.delivery_count}, duration: {actual_duration:.1f}ms)")

            return {
                'success': True,
                'amount': amount,
                'duration': self.duration_ms,
                'actualDuration': actual_duration,
                'deliveryCount': self.delivery_count,
                'nextAvailable': current_time + self.cooldown_ms
            }

        except Exception as e:
            self.last_error = str(e)
            self.error_count += 1
            logger.error(f"Water delivery failed: {e}")
            return {
                'success': False,
                'error': str(e)
            }
