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
        self.logger = logging.getLogger('hallway')

    def send(self, msg_type: str, data: Any):
        """Send structured data to Node process"""
        message = IpcMessage(type=msg_type, data=data)
        print(json.dumps(message.__dict__), flush=True)
        self.logger.debug(f"Sent message: {msg_type} - {data}")

    def debug(self, message: str):
        """Log debug information"""
        self.logger.debug(message) 