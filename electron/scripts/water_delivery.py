import nidaqmx
import sys
import time

def setup_task():
    # Initialize the NI-DAQmx task only once
    task = nidaqmx.Task()
    task.ao_channels.add_ao_voltage_chan("Dev1/ao0", min_val=0.0, max_val=5.0)
    task.timing.samp_timing_type = nidaqmx.constants.SampleTimingType.ON_DEMAND
    return task

def deliver_water(task, voltage=5.0, duration_ms=70):
    duration_s = duration_ms / 1000.0  # Convert milliseconds to seconds
    # Send the voltage pulse
    task.write([voltage], auto_start=True)
    time.sleep(duration_s)
    # Reset to 0V
    task.write([0], auto_start=True)

def main():
    task = setup_task()
    # Read commands continuously from stdin. This keeps the process alive.
    for line in sys.stdin:
        command = line.strip()
        if command == "deliver":
            try:
                deliver_water(task)
                print("success", flush=True)
            except Exception as e:
                print(f"error: {str(e)}", flush=True)
        else:
            print("error: unknown command", flush=True)

if __name__ == "__main__":
    main()