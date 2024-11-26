import serial
from typing import Dict, Any
import json

class SerialHandler:
    def __init__(self, port: str = 'COM3', baudrate: int = 115200):
        self.serial = serial.Serial(port, baudrate)
        self.initialize_communication()
    
    def initialize_communication(self):
        """Replicates Userpopup_adns_water_nosave.m initialization"""
        self.serial.write(b'10000,50,10,1')
        # ... rest of initialization
    
    def read_data(self) -> Dict[str, Any]:
        """Implements grittonmove.m data reading logic"""
        if not self.serial.in_waiting:
            return None
            
        data = self.serial.readline().decode('utf-8').strip()
        values = data.split(',')
        
        return {
            'x': float(values[7]),
            'y': float(values[8]),
            'theta': float(values[9]),
            'water': int(values[10]),
            'timestamp': float(values[0])
        } 