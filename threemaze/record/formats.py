"""Data format v1: every table and log of a session folder, column by column.

This module is the code twin of docs/data-format-v1.md; test/backend/runtime/test_data_format.py
checks that the page lists exactly these columns and fields. Until plan item DPR-26 freezes the
format as 1.0.0 (before v1.0-rc), it is a draft: FORMAT_VERSION carries a draft number, which a
change before the freeze raises, and every session.json records it.

Units are the last part of a column name: _us and _ns (integer microseconds and nanoseconds),
_cm (scene units, 1 unit = 1 cm, ADR-0001), _rad, _counts (raw sensor counts). Device times are
integers.
"""
from dataclasses import dataclass

from .tables import Column, TableSpec

FORMAT = "three-maze-session"
FORMAT_VERSION = "1.0.0-draft.1"

SAMPLES = "samples.tsv"
POSES = "pose.tsv"
FRAMES = "frames.tsv"
TRIALS = "trials.tsv"
EVENTS = "events.jsonl"
COMMANDS = "commands.jsonl"
LONG_TASKS = "longtasks.jsonl"

MAX_AXES = 16  # device protocol v1, section 4.1


def _c(name, kind, doc, unit=None, optional=False):
    return Column(name, kind, unit, doc, optional)


def samples_spec(n_axes: int) -> TableSpec:
    """samples.tsv for a motion device with n_axes sensor axes (1 to 16)."""
    if not 1 <= n_axes <= MAX_AXES:
        raise ValueError(f"a motion device has 1 to {MAX_AXES} sensor axes, not {n_axes}")
    raw = tuple(
        _c(f"raw_{j}_counts", "number",
           f"Counts of sensor axis {j} since the previous sample, before calibration: integers from"
           " a v1 device (the difference of its running totals, device protocol v1, D6 and"
           " section 7.2).", "counts")
        for j in range(n_axes))
    return TableSpec(SAMPLES, (
        _c("seq", "int",
           "Sample number, uint32: the device's own (seq_source device) or numbered by the runtime"
           " from 0 (seq_source host, profile legacy-v0.3); session.json says which."),
        _c("t_dev_us", "int",
           "End of the sample's window on the device clock, unwrapped to 64 bits (device protocol"
           " v1, H6); the session clock at receipt in us for a device without a clock"
           " (time_source host).", "us"),
        _c("t_host_ns", "int",
           "Session clock (time.perf_counter_ns) at the read that completed the sample's line"
           " (device protocol v1, H1): when the runtime received it.", "ns"),
        _c("dt_us", "int",
           "Time the displacement covers: t_dev_us minus the previous sample's, so longer than one"
           " period after a gap; an estimate for a stream's first sample when flags bit 8 is set.",
           "us"),
        _c("gap", "int",
           "Samples lost just before this one: counted from seq (seq_source device) or inferred"
           " from the device clock (seq_source host); 0 when none."),
        _c("flags", "int",
           "Bits 0-7: the device's flags byte (bit 0 count_incomplete, bit 1 no_tracking); bit 8"
           " (256): dt_estimated; bit 9 (512): dt_mismatch. The flags of the link protocol's"
           " sample (protocol/v1/SPEC.md, section 8)."),
        *raw,
        _c("d_fwd_cm", "float",
           "Forward displacement: row 0 of C * raw, C the rig file's calibration matrix, summed"
           " over the axes in ascending order in double precision (device protocol v1, 7.2).",
           "cm"),
        _c("d_left_cm", "float", "Leftward displacement, left positive: row 1 of C * raw.", "cm"),
        _c("d_yaw_rad", "float",
           "Heading change, counter-clockwise seen from above positive: row 2 of C * raw.", "rad"),
    ), "One row per device sample the runtime accepted, written when it was received, whatever the"
       " renderer does.")


POSES_SPEC = TableSpec(POSES, (
    _c("seq", "int",
       "The sample this pose follows: the motion core's pose after it processed sample seq (one"
       " pose per sample, link protocol P1); joins pose.tsv to samples.tsv."),
    _c("epoch", "int", "Teleport and reset counter in force after the sample (ADR-0002)."),
    _c("t_dev_us", "int", "t_dev_us of sample seq.", "us"),
    _c("x_cm", "float", "Agent position x (scene units, 1 unit = 1 cm).", "cm"),
    _c("feet_y_cm", "float",
       "Height of the agent's feet; the eye is at feet_y_cm plus the rig file's eye height"
       " (ADR-0001 R3).", "cm"),
    _c("z_cm", "float", "Agent position z.", "cm"),
    _c("yaw_rad", "float",
       "Heading as the motion core integrated it: 0 looks down -Z, counter-clockwise seen from"
       " above positive (ADR-0001 R1).", "rad"),
    _c("contact", "bool", "The mover met a wall during this sample."),
    _c("airborne", "bool", "No floor under the agent after this sample (falling)."),
    _c("world", "token", "The world of the pose (phase 1: the experiment's only world)."),
    _c("t_host_ns", "int", "Session clock when the pose's batch reached the runtime.", "ns"),
), "One row per pose the motion worker sent (pose.batch), in the order received.")

FRAMES_SPEC = TableSpec(FRAMES, (
    _c("frame", "int",
       "Frame index of the render host: 0 for the first requestAnimationFrame callback after"
       " ready, then +1 per callback, so a jump means that frame records were lost."),
    _c("raf_us", "int",
       "The callback's requestAnimationFrame timestamp (the frame record's t_raf_us), on the"
       " render host's clock (time_origin_us).", "us"),
    _c("entry_us", "int", "performance.now() when the callback started (t_start_us).", "us"),
    _c("exit_us", "int", "performance.now() when the callback returned (t_end_us).", "us"),
    _c("epoch", "int", "The epoch of the pose drawn."),
    _c("seq", "int",
       "The sample whose pose was drawn, or the earlier of two when the frame interpolated;"
       " empty before the first pose.", optional=True),
    _c("seq_next", "int",
       "The later of the two samples when the frame interpolated between poses; empty"
       " otherwise.", optional=True),
    _c("t_dev_us", "int",
       "The device time the drawn pose stands for; empty before the first pose.", "us",
       optional=True),
    _c("flags", "int",
       "The frame record's flags as sent: bit 0 blank, bit 1 frozen, bit 2 hidden, bit 3 context"
       " lost, bit 4 programs or textures rose after ready; bits 5-7 reserved (link protocol,"
       " section 11). The next five columns repeat bits 0-4."),
    _c("blank", "bool", "flags bit 0: the screen was blanked."),
    _c("frozen", "bool", "flags bit 1: motion was frozen."),
    _c("hidden", "bool", "flags bit 2: the document was hidden."),
    _c("context_lost", "bool", "flags bit 3: the WebGL context was lost."),
    _c("post_ready_rise", "bool",
       "flags bit 4: shader programs or textures rose after ready (ADR-0003 1b)."),
    _c("world", "token", "The world the frame showed."),
    _c("time_origin_us", "int",
       "performance.timeOrigin of the render host's realm in whole us: names the clock of"
       " raf_us, entry_us and exit_us; not itself a time stamp (link protocol, R1).", "us"),
    _c("t_host_ns", "int", "Session clock when the frame's batch reached the runtime.", "ns"),
), "One row per rendered frame (render.report frames), in the order received. The columns"
   " frame, raf_us, entry_us, exit_us, hidden, context_lost and post_ready_rise are the input of"
   " the gate analysis (docs/timing/gate-analysis.md, section 2).")

FRAME_FLAG_COLUMNS = ("blank", "frozen", "hidden", "context_lost", "post_ready_rise")

TRIALS_SPEC = TableSpec(TRIALS, (
    _c("trial", "int", "Trial index, as the task numbers its trials."),
    _c("start_seq", "int", "Sample at which the trial started (the trial_start event's seq)."),
    _c("start_epoch", "int", "Epoch at the start."),
    _c("start_t_dev_us", "int", "Device time of the start sample.", "us"),
    _c("start_t_host_ns", "int", "Session clock when the trial_start event reached the runtime.",
       "ns"),
    _c("end_seq", "int", "Sample at which the trial ended; empty if it had not ended when the"
       " session ended.", optional=True),
    _c("end_epoch", "int", "Epoch at the end (before any teleport that the end causes).",
       optional=True),
    _c("end_t_dev_us", "int", "Device time of the end sample.", "us", optional=True),
    _c("end_t_host_ns", "int", "Session clock when the trial_end event reached the runtime.", "ns",
       optional=True),
    _c("outcome", "token",
       "The outcome the task gave when it ended the trial (a name from the experiment file);"
       " empty if the trial had not ended when the session ended.", optional=True),
    _c("ended", "bool", "1 if the task ended the trial; 0 if the session ended first."),
    _c("rewards_requested", "int", "Reward requests that belong to this trial."),
    _c("reward_requested_us", "int",
       "Pulse width commanded by those requests, summed.", "us"),
    _c("rewards_done", "int", "Requests whose outcome is done: delivered and acknowledged."),
    _c("rewards_truncated", "int",
       "Requests whose pulse was cut short (the session stopped during it)."),
    _c("rewards_refused", "int",
       "Requests refused (safety envelope, or the device refused the pulse)."),
    _c("rewards_failed", "int", "Requests that failed in the output device."),
    _c("rewards_unresolved", "int",
       "Requests without an acknowledgement: outcome unresolved, or no outcome at all when the"
       " session ended."),
    _c("reward_delivered_us", "int",
       "Pulse width reported with the done and truncated outcomes, summed (outcomes that report"
       " no width add nothing).", "us"),
), "One row per trial, written once the trial has ended, the next trial has started (or the"
   " session ended) and every reward of the trial has an outcome, so that it states commanded"
   " against acknowledged reward.")


@dataclass(frozen=True)
class Field:
    """A top-level field of a log's JSON objects."""

    name: str
    required: bool
    doc: str


@dataclass(frozen=True)
class LogSpec:
    file: str
    fields: tuple[Field, ...]
    doc: str

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(field.name for field in self.fields)


EVENT_SOURCES = ("motion", "task", "render", "runtime", "device", "operator")

EVENTS_SPEC = LogSpec(EVENTS, (
    Field("t_host_ns", True, "Session clock when the event reached the runtime, or happened in"
                             " it."),
    Field("src", True, "Who reported it: " + ", ".join(EVENT_SOURCES) + "."),
    Field("kind", True, "What happened: for example zone, fall, land, teleport_applied, seq_gap"
                        " or guard (motion), trial_start or trial_end (task), ready or clock"
                        " (render), state or warning (runtime)."),
    Field("seq", False, "Stamp: the sample the event belongs to (ADR-0002, Stamps)."),
    Field("epoch", False, "Stamp: the epoch after the event."),
    Field("t_dev_us", False, "Stamp: t_dev_us of sample seq."),
    Field("world", False, "Stamp: the world the event happened in."),
    Field("stale", False, "true: the event carries an epoch older than the runtime's, so it was"
                          " logged and not acted on (plan item DPR-06b)."),
    Field("data", False, "Every other field of the event, as reported."),
), "Every non-stream event, one JSON object per line, in the order the runtime received them (for"
   " the motion worker's events: dispatch order, link protocol V2).")

COMMAND_KINDS = ("command", "ack", "request", "outcome")
OUTCOMES = ("done", "truncated", "refused", "failed", "unresolved")
TIMING_CLASSES = ("hardware", "software", "unreported")

COMMANDS_SPEC = LogSpec(COMMANDS, (
    Field("t_host_ns", True, "Session clock when the record reached the runtime, or was sent by"
                             " it."),
    Field("src", True, "Who sent it: motion (the motion worker), runtime, device or operator."),
    Field("kind", True, "command: a command to the motion worker; ack: the motion worker's"
                        " acknowledgement of one; request: an output request, such as a reward;"
                        " outcome: the one terminal outcome of a request."),
    Field("cmd_id", True, "The command's id: unique within a session, shared by a command and"
                          " its ack, and by a request and its outcome."),
    Field("action", False, "What is commanded or requested: reward, teleport, freeze, display or"
                           " setGain."),
    Field("trial", False, "Request: the trial a reward belongs to, when the requester names it."),
    Field("seq", False, "Stamp of the sample that triggered the request or command."),
    Field("epoch", False, "Stamp: the epoch, or for a command, the epoch it brings in."),
    Field("t_dev_us", False, "Stamp: t_dev_us of sample seq."),
    Field("apply_seq", False, "Command: the sample after which it is to be applied (ADR-0002,"
                              " Code tasks)."),
    Field("applied_seq", False, "Ack: the sample after which it was applied."),
    Field("width_us", False, "Request: the pulse width commanded. Outcome: the width the device"
                             " measured or the runtime timed, when reported."),
    Field("outcome", False, "Outcome: " + ", ".join(OUTCOMES) + "."),
    Field("timing", False, "Outcome: the timing class of the width, "
                           + ", ".join(TIMING_CLASSES) + " (device protocol v1, section 8.4)."),
    Field("device", False, "The output device, by its name in the rig file."),
    Field("data", False, "Any other field."),
), "Every command and acknowledgement, every output request and its outcome, one JSON object per"
   " line, in the order the runtime received or sent them: what a replay needs besides the"
   " samples (plan item DPR-26).")

LONG_TASKS_SPEC = LogSpec(LONG_TASKS, (
    Field("type", True, "longtask or long-animation-frame (PerformanceEntry.entryType), or handler"
                        " (one of the app's own timed handlers)."),
    Field("name", False, "PerformanceEntry.name, or the handler's name."),
    Field("start_us", True, "Start, on the render host's clock (time_origin_us)."),
    Field("duration_us", True, "Duration."),
    Field("blocking_us", False, "long-animation-frame: blockingDuration."),
    Field("render_start_us", False, "long-animation-frame: renderStart."),
    Field("style_layout_start_us", False, "long-animation-frame: styleAndLayoutStart."),
    Field("time_origin_us", True, "performance.timeOrigin of the render host's realm, in whole us:"
                                  " the clock of the times above."),
    Field("t_host_ns", True, "Session clock when the entry's batch reached the runtime."),
), "Long tasks of the stimulus window's main thread (render.report long_tasks), one JSON object"
   " per line, in the order received: the second input of the gate analysis.")

TABLE_SPECS = {POSES: POSES_SPEC, FRAMES: FRAMES_SPEC, TRIALS: TRIALS_SPEC}
LOG_SPECS = {EVENTS: EVENTS_SPEC, COMMANDS: COMMANDS_SPEC, LONG_TASKS: LONG_TASKS_SPEC}


def table_spec(file: str, header: list[str] | None = None) -> TableSpec:
    """The spec of a table by its file name; samples.tsv takes its axis count from its header."""
    if file == SAMPLES:
        if header is None:
            raise ValueError("samples.tsv: the header gives the number of axes")
        return samples_spec(sum(1 for name in header if name.startswith("raw_")))
    return TABLE_SPECS[file]
