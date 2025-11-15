"""Data logging to TSV/CSV/JSON files"""
import os
import asyncio
import json
from typing import Dict, Any, List, Optional
import logging
from pathlib import Path
import time


logger = logging.getLogger(__name__)


class DataLogger:
    """Handles data logging to files"""

    def __init__(self):
        self.file_path: Optional[Path] = None
        self.file_handle = None
        self.format = 'tsv'
        self.buffer: List[str] = []
        self.buffer_size = 100
        self.entry_count = 0
        self.is_active = False

    async def start_logging(self, filename: str, format_type: str = 'tsv') -> Dict[str, Any]:
        """Start data logging"""
        try:
            # Parse configuration
            log_path = Path('logs')
            self.format = format_type
            include_headers = True

            # Create log directory
            log_path.mkdir(parents=True, exist_ok=True)

            # Create log file
            self.file_path = log_path / filename
            self.file_handle = open(self.file_path, 'w', encoding='utf-8')

            # Write headers if requested
            if include_headers and self.format in ['tsv', 'csv']:
                separator = '\t' if self.format == 'tsv' else ','
                headers = ['timestamp', 'x', 'y', 'theta', 'input_x', 'input_y', 'water', 'trial_time']
                self.file_handle.write(separator.join(headers) + '\n')

            self.is_active = True
            self.entry_count = 0

            logger.info(f"Data logging started: {self.file_path}")

            return {
                'success': True,
                'filename': filename,
                'fullPath': str(self.file_path.absolute()),
                'format': self.format
            }

        except Exception as e:
            logger.error(f"Failed to start logging: {e}")
            return {
                'success': False,
                'error': str(e)
            }

    async def log_entry(self, data: Dict[str, Any]) -> bool:
        """Write data entry to log (alias for write)"""
        return await self.write(data)

    async def write(self, data: Dict[str, Any]) -> bool:
        """Write data entry to log"""
        if not self.is_active:
            return False

        try:
            if self.format == 'json':
                line = json.dumps(data) + '\n'
            elif self.format in ['tsv', 'csv']:
                separator = '\t' if self.format == 'tsv' else ','
                values = [
                    str(data.get('timestamp', '')),
                    str(data.get('x', 0)),
                    str(data.get('y', 0)),
                    str(data.get('theta', 0)),
                    str(data.get('input_x', 0)),
                    str(data.get('input_y', 0)),
                    str(data.get('water', 0)),
                    str(data.get('trial_time', 0))
                ]
                line = separator.join(values) + '\n'
            else:
                logger.warning(f"Unknown format: {self.format}")
                return False

            self.buffer.append(line)
            self.entry_count += 1

            # Auto-flush if buffer full
            if len(self.buffer) >= self.buffer_size:
                await self.flush()

            return True

        except Exception as e:
            logger.error(f"Failed to write log entry: {e}")
            return False

    async def flush(self) -> bool:
        """Flush buffer to file"""
        if not self.buffer or not self.file_handle:
            return True

        try:
            self.file_handle.writelines(self.buffer)
            self.file_handle.flush()
            self.buffer.clear()
            return True
        except Exception as e:
            logger.error(f"Failed to flush log buffer: {e}")
            return False

    async def stop_logging(self) -> Dict[str, Any]:
        """Stop data logging"""
        try:
            # Flush remaining buffer
            if self.buffer:
                await self.flush()

            # Close file
            if self.file_handle:
                self.file_handle.close()
                self.file_handle = None

            file_size = self.file_path.stat().st_size if self.file_path else 0

            result = {
                'success': True,
                'totalEntries': self.entry_count,
                'fileSize': file_size
            }

            self.is_active = False
            logger.info(f"Data logging stopped. Entries: {self.entry_count}, Size: {file_size} bytes")

            return result

        except Exception as e:
            logger.error(f"Failed to stop logging: {e}")
            return {
                'success': False,
                'error': str(e)
            }

    async def start(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Alternative start method (for compatibility with other hardware)"""
        filename = config.get('filename', f'experiment_{int(time.time())}.tsv')
        format_type = config.get('format', 'tsv')
        return await self.start_logging(filename, format_type)

    async def stop(self) -> Dict[str, Any]:
        """Alternative stop method (for compatibility)"""
        return await self.stop_logging()
