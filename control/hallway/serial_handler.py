import serial
from typing import Dict, Any
import numpy as np
import time

class SerialHandler:
    def __init__(self):
        self.serial = None
        
    def initialize_communication(self):
        """Initialize serial communication with the same parameters as MATLAB"""
        try:
            print("Opening serial port COM3...", flush=True)
            self.serial = serial.Serial('COM3', baudrate=115200)
            
            print("Waiting for connection...", flush=True)
            time.sleep(2)
            
            init_string = "10000,50,10,1"
            print(f"Sending init string: {init_string}", flush=True)
            self.serial.write(init_string.encode() + b'\n')
            
            print("Reading responses...", flush=True)
            time.sleep(0.1)
            nreps = self.serial.readline().decode().strip()
            print(f"nreps: {nreps}", flush=True)
            repcycles = self.serial.readline().decode().strip()
            print(f"repcycles: {repcycles}", flush=True)
            water_jitter = self.serial.readline().decode().strip()
            print(f"water_jitter: {water_jitter}", flush=True)
            water_spacing = self.serial.readline().decode().strip()
            print(f"water_spacing: {water_spacing}", flush=True)
            
            time.sleep(0.5)
            for i in range(3):
                blank = self.serial.readline().decode().strip()
                print(f"blank {i}: {blank}", flush=True)
                
        except Exception as e:
            print(f"Serial initialization error: {str(e)}", flush=True)
            raise
        
    def read_data(self):
        """Read and parse serial data"""
        try:
            line = self.serial.readline().decode().strip()
            values = line.split(',')
            if len(values) >= 11:  # Make sure we have all expected values
                return {
                    'timestamp': values[0],
                    'x': float(values[7]),
                    'y': float(values[8]),
                    'theta': float(values[9]),
                    'water': int(values[10])
                }
        except Exception as e:
            print(f"Error reading serial data: {e}")
        return None
        
    def close(self):
        """Close serial connection"""
        if self.serial and self.serial.is_open:
            self.serial.close()