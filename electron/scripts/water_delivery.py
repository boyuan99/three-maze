import nidaqmx
import time
import sys

def deliver_water(voltage=5.0, duration_ms=17):
    try:
        duration_s = duration_ms / 1000.0  # Convert to seconds
        print(f"Opening NI-DAQmx task (Voltage: {voltage}V, Duration: {duration_ms}ms)...", flush=True)
        
        with nidaqmx.Task() as task:
            print("Configuring channel...", flush=True)
            task.ao_channels.add_ao_voltage_chan("Dev1/ao0", min_val=0.0, max_val=5.0)
            task.timing.samp_timing_type = nidaqmx.constants.SampleTimingType.ON_DEMAND
            
            print(f"Sending {voltage}V pulse...", flush=True)
            task.write([voltage], auto_start=True)
            time.sleep(duration_s)
            
            print("Resetting to 0V...", flush=True)
            task.write([0], auto_start=True)
            
        print("success", flush=True)
    except Exception as e:
        print(f"error: {str(e)}", flush=True)

if __name__ == "__main__":
    deliver_water()