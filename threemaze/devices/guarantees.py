"""Guarantee levels of device protocol v1, section 8 (docs/protocol/device-v1.md): which guarantees
a device's stream gives, and what a session can claim from them. Every session record states them
for each device (rule H9), so that a claim about lost or corrupted samples names the level of the
device that produced the data.

Pure: the profile and what the device sent decide. The profile that reads a device uses these to
state its record and the link protocol's guarantee level (threemaze/devices/profiles: v1.py); the
legacy-v0.3 profile's flags (rule L7) come with its adapter (plan item DPR-04).
"""
from collections.abc import Mapping
from typing import Any

# Section 8.1, in the order of its table
FLAGS = ("hello", "device_seq", "device_time", "window_dt", "checksum", "running_totals",
         "stop_report")
# Section 8.4
OUTPUT_TIMING = ("hardware", "software", "unreported")


def v1_flags(*, hello: bool, stop_report: bool) -> dict[str, bool]:
    """The flags of a stream read with profile v1. Its samples carry the device's sequence number,
    its clock, the window length, a checksum and running totals by rule (D3 to D6, F3); whether
    the hello matched (H5) and whether a stop report arrived (section 4.3) depend on the device."""
    return {"hello": hello, "device_seq": True, "device_time": True, "window_dt": True,
            "checksum": True, "running_totals": True, "stop_report": stop_report}


def levels(flags: Mapping[str, bool]) -> dict[str, str]:
    """Section 8.2: completeness follows from device_seq and device_time, integrity from checksum;
    section 8.3: who numbered the samples, and whose clock t_dev_us is."""
    if flags["device_seq"]:
        completeness = "counted"
    elif flags["device_time"]:
        completeness = "inferred"
    else:
        completeness = "received"
    return {"completeness": completeness,
            "integrity": "crc8" if flags["checksum"] else "parse-only",
            "seq_source": "device" if flags["device_seq"] else "host",
            "time_source": "device" if flags["device_time"] else "host"}


def protocol_record(profile: str, flags: Mapping[str, bool]) -> dict[str, Any]:
    """The fields of section 8.3 that the profile and the flags decide (the parsed hello, the
    counters and, for output devices, output_timing come from what the profile read)."""
    if set(flags) != set(FLAGS):
        raise ValueError(f"guarantee flags must be exactly {', '.join(FLAGS)}")
    return {"profile": profile, "guarantees": {name: bool(flags[name]) for name in FLAGS},
            **levels(flags)}
