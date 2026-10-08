"""State shared by the sim modules; set by threemaze_sim.activate()."""
settings = None    # config.Settings
sim_log = None     # simlog.JsonlLog -> $THREEMAZE_SIM_DIR/sim.jsonl
serial_log = None  # simlog.JsonlLog -> $THREEMAZE_SIM_DIR/serial.jsonl
daq_log = None     # simlog.JsonlLog -> $THREEMAZE_SIM_DIR/daq.jsonl
