from dataclasses import dataclass
from typing import Any, Optional
import json
import sys
import logging

@dataclass
class IpcMessage:
    type: str
    data: Any

class IpcHandler:
    def __init__(self):
        # Set up logging to file instead of stdout
        logging.basicConfig(
            filename='debug.log',
            level=logging.DEBUG,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
        )
        self.logger = logging.getLogger('hallway')

    def send(self, msg_type: str, data: Any):
        """Send structured data to Node process"""
        message = IpcMessage(type=msg_type, data=data)
        print(json.dumps(message.__dict__), flush=True)

    def debug(self, message: str):
        """Log debug information to file"""
        self.logger.debug(message)
        # If you need console output for debugging:
        print(f"DEBUG: {message}", file=sys.stderr, flush=True) 