# Device protocol v1

- Status: normative, version 1.0 (2026-10-09)
- Applies to: every motion device (a ball or treadmill sensor) and every output device (a valve or another actuator) that the three-maze rig runtime reads or drives over a serial port (USB CDC or a UART)
- Related: [ADR-0001](../adr/0001-player-mover.md) (R1: the motion core consumes device samples in sequence order, each once, and integrates on device time), [ADR-0002](../adr/0002-task-engine-location.md) (Rig runtime, Clock and order, Gaps)

Device firmware is the rig builder's own code. three-maze does not ship, plan or require any particular firmware (project owner, 2026-10-09). This page says what a device must send, what the rig runtime does with it, and why each rule exists. A device that follows it gets the strongest guarantees three-maze can give about lost and corrupted samples. A device that does not, such as the device stream that three-maze v0.3 reads, is read through a *profile* that states which guarantees are missing, and every session records them ([section 8](#8-guarantee-levels), [section 10](#10-profile-legacy-v03)).

Phase 1 of three-maze reads two profiles only, `v1` and `legacy-v0.3` (project owner, 2026-10-09). A device whose stream follows neither cannot be used yet unless its firmware is changed to follow this protocol. Phase 2 of the roadmap adds two ways to connect such a device as it is (three-maze-notes: decision log, DEC-039; `plan/phase1-plan.md`, phase-2 item DPR-28; design in `docs-site/docs/design/backend-modules.md:156-178`):

- a configurable text-line profile: the rig file declares the init lines, the fields of each line, and which fields carry the device time and the motion counts, so a device that prints one text line per sample is connected without writing code;
- an entry point for a driver the rig builder writes, for streams that such a field list cannot describe, for example binary framing, a handshake, USB HID or a network stream.

Either way the host hands the motion core the same device samples ([section 7.2](#72-the-device-sample-the-host-derives)) and records in every session which guarantees the stream gives ([section 8](#8-guarantee-levels)), as it does for the two profiles on this page.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119 and RFC 8174 when they appear in capitals. Every MUST has a rule id (F for framing, D for devices, H for the host, L for the legacy profile), a reason, and the test that checks it ([section 9](#9-rules-reasons-and-tests)).

## Contents

1. [Terms](#1-terms)
2. [Overview](#2-overview)
3. [Framing](#3-framing)
4. [Lines from the device](#4-lines-from-the-device)
5. [Commands from the host](#5-commands-from-the-host)
6. [Session sequence](#6-session-sequence)
7. [What the host does with each line](#7-what-the-host-does-with-each-line)
8. [Guarantee levels](#8-guarantee-levels)
9. [Rules, reasons and tests](#9-rules-reasons-and-tests)
10. [Profile legacy-v0.3](#10-profile-legacy-v03)
11. [Golden lines](#11-golden-lines)
12. [Notes for device builders (non-normative)](#12-notes-for-device-builders-non-normative)
13. [Versioning](#13-versioning)
14. [Sources](#14-sources)

## 1. Terms

- **Device**: hardware that exchanges lines with the rig runtime over one serial port. A *motion device* sends samples; an *output device* drives outputs on command. One device may be both.
- **Host**: the three-maze rig runtime (Python) at the other end of the port.
- **Sample**: one integration window of a motion device: the window's end time on the device clock, its length, and the running count total of every sensor axis at its end.
- **Stream**: the samples a device sends between one `start` command and the next `stop` command.
- **Profile**: the rules the host uses to read one kind of device: `v1` (this protocol) or `legacy-v0.3` ([section 10](#10-profile-legacy-v03)). The rig file names the profile of each device.
- **Guarantee level**: what a session's data can show about lost and corrupted samples, given what the device sends ([section 8](#8-guarantee-levels)).
- **Device sample**: the record the host derives from a sample and hands to the motion core: sequence number seq, device time t_dev, and body-frame displacement (ADR-0001, Terms; [section 7.2](#72-the-device-sample-the-host-derives)).

## 2. Overview

A motion device announces itself, streams one line per sample while the host lets it, and may add the event lines its hello declares. In this exchange the words `host` and `device` only show the direction; they are not part of the lines.

```text
host   hello*92
device H,threemaze-device,1.0,ball-01,4000,4,fw=demo-1.2,flags=1,lick=1,fclk=1*D6
host   start*3F
device S,0,1000000,4000,0,12,-1,35,3*37
device L,0,1002500,1*D5
device S,1,1004000,4000,0,22,-1,65,5*A2
device F,1,1006100*71
device S,2,1008000,4000,1,-2026,6,65,5*F2
device S,5,1020000,4000,0,-2010,6,90,7*F3
host   stop*A5
device Z,6,1022000*9D
```

The device `ball-01` samples every 4,000 µs (250 Hz) and has 4 sensor axes; its hello also declares one lick channel (`lick=1`) and a frame-clock input (`fclk=1`), so it may send `L` and `F` lines (section 4.4). Each `S` line carries the sample's sequence number, its end time in µs on the device clock, the window length, a flags byte and the running total of every axis since `start`. A lick began at device time 1,002,500 µs and a frame-clock edge arrived at 1,006,100 µs. Samples 3 and 4 were lost between the device and the host: the host counts the gap from the sequence numbers, and because the counts are running totals, sample 5 still carries their motion. The stop report says the device sent 6 samples, so the host can show that it received 4 and counted 2 as lost. Every line ends with `*` and a CRC-8 checksum in hexadecimal; [section 11](#11-golden-lines) gives the expected result of every line.

| Line | Direction | Who must use it | Content |
|---|---|---|---|
| `hello` | host to device | every device answers it | request for an `H` line |
| `H` | device to host | every device | protocol, version, device id, sample period, number of axes, optional keys |
| `start`, `stop` | host to device | motion devices | begin and end a stream |
| `S` | device to host | motion devices | one sample |
| `Z` | device to host | SHOULD, motion devices | stop report: how many samples the stream had |
| `L`, `F` | device to host | MAY, if the hello declares them (`lick`, `fclk=1`) | lick edge, frame-clock edge |
| `beat` | host to device | sent to devices that declare a heartbeat | heartbeat |
| `pulse` | host to device | output devices | open an output for a given time |
| `A`, `X` | device to host | output devices that declare `ack=1` | pulse done (device-measured on and off times), pulse refused or failed |
| `E` | device to host | MAY | diagnostic message |

## 3. Framing

These rules apply to lines in both directions.

**F1. Lines.** A line is a *record* of printable ASCII characters (bytes 0x20 to 0x7E) other than `*`, then `*`, two hexadecimal digits of checksum, and LF (0x0A). A CR (0x0D) directly before the LF is allowed, so `Serial.println()` style output is fine. *Reason:* a reader that loses its place after corruption finds the next line at the next LF; text lines can be read in any serial monitor, and the raw-line log is the same text the parser saw.

**F2. Length.** A line is at most 254 bytes, not counting CR and LF. *Reason:* the reader keeps a bounded buffer; a line that never ends is discarded at the limit and the reader resynchronises at the next LF instead of growing without bound. The longest `S` line this protocol allows is 233 bytes (16 axes, every field at its widest).

**F3. Checksum.** The two hexadecimal digits after `*` are the CRC-8 of every byte of the record, from its first byte up to, not including, the `*`. The CRC is the catalogue's CRC-8/SMBUS: polynomial 0x07 (x⁸ + x² + x + 1), initial value 0x00, no input or output reflection, final XOR 0x00; for the nine ASCII bytes `123456789` it is 0xF4. Senders write the digits in upper case; receivers accept either case. *Reason:* a corrupted line must never be used as motion or as a command, and a digit corrupted into another digit still passes every field-count and syntax check. This polynomial has x + 1 as a factor, so the CRC detects every error that flips an odd number of bits and every error confined to 8 consecutive bits; of other random corruptions, about 1 in 256 passes. A sample whose line is rejected shows up as a sequence gap (rule H3).

**F4. Fields.** A record is a type token followed by fields, separated by single commas. No field contains a space, except the free text at the end of an `E` line (section 4.6). Integer fields are decimal ASCII: unsigned fields are digits only, signed fields may start with `-`. Senders write no leading zeros (except the value `0` itself); receivers accept them and read the same value. *Reason:* one unambiguous parse per line, identical in C, Python and TypeScript, so live parsing and re-parsing the raw-line log give the same result.

Reference code for F3 (non-normative):

```c
uint8_t crc8(const char *s, size_t n) {          /* CRC-8/SMBUS */
  uint8_t crc = 0;
  for (size_t i = 0; i < n; i++) {
    crc ^= (uint8_t)s[i];
    for (int b = 0; b < 8; b++)
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  }
  return crc;
}
```

```python
def crc8(data: bytes) -> int:                   # CRC-8/SMBUS
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc

assert crc8(b"123456789") == 0xF4
```

Value ranges used below: *uint32* is 0 to 4,294,967,295; *int32* is −2,147,483,648 to 2,147,483,647.

## 4. Lines from the device

Device lines start with one upper-case letter. A host ignores a line of an unknown type that has a valid checksum (it counts it and keeps it in the raw-line log), so later minor versions can add types.

### 4.1 Hello: `H`

```text
H,threemaze-device,<version>,<device_id>,<period_us>,<n_axes>[,<key>=<value>]...
```

| Field | Format | Meaning |
|---|---|---|
| `threemaze-device` | literal | protocol name |
| `version` | `1.<minor>`, for example `1.0` | protocol version this device implements |
| `device_id` | 1 to 32 characters from `A-Z a-z 0-9 . _ -` | identifies this physical device, for example a serial number |
| `period_us` | uint32 | nominal sample period in µs; 0 for a device without samples |
| `n_axes` | integer 0 to 16 | number of sensor axes in each `S` line; 0 for a device without samples |
| `key=value` | key: `a-z 0-9 _`; value: 1 to 32 characters from `A-Z a-z 0-9 . _ + -` | optional properties, in any order |

Keys defined in version 1.0 (absent keys take the default):

| Key | Default | Meaning |
|---|---|---|
| `fw` | none | the device's own firmware version; recorded, never interpreted |
| `flags` | `0` | bit mask of the `S` flags this device can raise (section 4.2) |
| `lick` | `0` | number of lick channels it reports with `L` lines |
| `fclk` | `0` | `1` if it reports frame-clock edges with `F` lines |
| `out` | `0` | number of output channels it drives |
| `ack` | `0` | `1` if it answers every `pulse` with `A` or `X` |
| `hb` | none | heartbeat timeout in ms: the device acts on missing `beat` commands after this long |

**D1. Hello.** A device MUST answer every `hello` command with exactly one `H` line. *Reason:* before it applies a calibration, the host checks that the device on the port is the one the rig file describes, with the axis count and period the calibration was made for (rule H5), and records its identity in the session. A swapped device or a changed rate would otherwise change the gain silently.

### 4.2 Sample: `S`

```text
S,<seq>,<t_us>,<dt_us>,<flags>,<total_1>,...,<total_n>
```

| Field | Format | Meaning |
|---|---|---|
| `seq` | uint32 | sample number: 0 for the first sample after `start`, then +1 per sample, wrapping from 4,294,967,295 to 0 |
| `t_us` | uint32 | device time at the end of the sample's window, in µs: the low 32 bits of a free-running microsecond clock |
| `dt_us` | uint32, at least 1 | length of the sample's window in µs |
| `flags` | integer 0 to 255 | bit 0 (value 1): `count_incomplete`, some motion in this window is missing from the totals (a sensor counter saturated or a sensor read failed); bit 1 (value 2): `no_tracking`, a sensor reported losing the surface during the window; bits 2 to 7: reserved, sent as 0 |
| `total_i` | int32, exactly `n_axes` of them | running total of axis i: the sum of every count the sensor reported for that axis since `start`, wrapping from 2,147,483,647 to −2,147,483,648 |

**D2. A sample every period.** While streaming, a motion device MUST send one `S` line per window, at its declared period, including windows in which nothing moved. *Reason:* ADR-0002 fires timers on samples ("a timer due at device time T fires on the first sample with t_dev ≥ T") and faults a session that receives no sample for longer than T_fault (ADR-0002, Gaps). A device that went quiet while the animal stood still would stop every timer and then look like a broken device.

**D3. Sequence numbers.** `seq` MUST be 0 for the first sample after each `start` and MUST increase by exactly 1 for every sample the device produces, modulo 2³². A sample that is produced but never arrives keeps its number: the device never renumbers. *Reason:* the host then counts every loss where it happened (ADR-0002, Gaps), including losses at the start of a stream, and uses each sample once and in order (ADR-0001 R1).

**D4. Device time.** `t_us` MUST be read from one free-running microsecond clock, taken at the end of the window, and MUST NOT be reset during a stream; between two samples it only increases, except for the wrap from 4,294,967,295 to 0 (every 2³² µs, about 71.6 minutes). *Reason:* the motion core integrates on device time and timers fire on device time (ADR-0001 R1; ADR-0002, Clock and order), which must be free of the jitter of USB delivery and of the host's scheduler.

**D5. Contiguous windows.** Each window MUST begin where the previous one ended: for consecutive samples, `dt_us` of sample k equals t_us(k) − t_us(k−1) modulo 2³². The first window of a stream begins when the device handles `start`. *Reason:* every count then belongs to exactly one window, and the time a displacement covers is known. `dt_us` gives the length of a stream's first window, which has no predecessor, and lets the host check the clock against the period.

**D6. Running totals of raw counts.** Each `total_i` MUST be the running total, since `start`, of the counts that sensor axis reported: integers, not scaled, not combined with other axes, not filtered and not converted to velocity. The axis order MUST be the same in every `S` line and is part of the device's documentation, which the rig file's calibration follows. *Reason:* calibration (cm per count, axis signs, how two sensors combine into forward, sideways and turning motion) lives in the rig file, where it is recorded and hashed with every session. Integer counts add up exactly, so a session can be replayed bit for bit. Velocities computed with an assumed period are what made v0.3's gain depend on the true sample period (ADR-0001, Context). Running totals rather than per-window counts make the displacement survive lost lines: the host takes differences of totals, so the next sample that arrives carries the motion of the lost ones, and a corrupted value that passed the checksum is undone by the next line. They also make D5 hold for counts by construction, since the device never has to read and clear an accumulator at the window boundary.

**D7. Flags.** The `flags` field MUST be present. A device MUST set a bit only when its condition held during the window, and MUST send the reserved bits as 0; the `flags` key of the hello says which bits it can detect at all. *Reason:* only the device can see a saturated counter or a sensor that lost the surface. The field reserves room for later bits without a new major version.

**D8. Only between start and stop.** A device MUST NOT send `S`, `L` or `F` lines except between handling `start` and handling `stop`. *Reason:* a sample left over from an earlier stream would otherwise be taken as part of the next one (rule H4).

### 4.3 Stop report: `Z`

```text
Z,<n_samples>,<t_us>
```

`n_samples` (uint32) is the number of `S` lines the device produced in the stream that `stop` ended; `t_us` is the device time at which it handled `stop`. A motion device SHOULD answer `stop` with a `Z` line. With it, the host counts (n_samples − 1 − s) modulo 2³² more samples as lost at the end of the stream, where s is the last accepted seq (all n_samples if no sample arrived). Without it, samples lost at the very end of a stream, after the last one that arrived, cannot be counted; the session records which case applies (section 8).

### 4.4 Event lines: `L` and `F`

```text
L,<channel>,<t_us>,<level>
F,<count>,<t_us>
```

`L` reports a lick edge: `channel` (integer 0 to 255, below the hello's `lick` value), the device time of the edge in µs, and `level` 1 for contact onset or 0 for its end. `F` reports an edge of an external frame clock (for example a microscope's frame trigger): `count` (uint32) is the number of such edges since `start`, 1 for the first, and `t_us` is the edge's device time. Both are optional (MAY), and a device sends only what its hello declares: `L` lines on channels below its `lick` value, `F` lines only with `fclk=1`. The host learns from the hello which of these inputs a device has, so that a session without `L` lines from a device that declares `lick=1` shows that no lick happened, not that the device has no lick sensor; any other `L` or `F` line breaks the field rules of its type, and the host rejects it (H2). How a device debounces a lick sensor is up to the device. The host takes every lick channel's level as 0 at `start`, so a device whose sensor is already in contact at `start` reports an onset at the time it handled `start`.

**D9. Event order.** A device that sends `L` or `F` lines MUST send them in time order, and MUST send each one before the `S` line of the window that contains its time (the first sample whose `t_us` is at or after the event's time). *Reason:* ADR-0002 dispatches non-motion inputs per sample, in arrival order, each logged with its dispatch seq (Clock and order). With this rule the host assigns every event to the next `S` line it receives, without reordering, so a live session and its replay agree. A host that receives an event after the `S` line of its window counts it (`late_events`) and assigns it to the next sample.

### 4.5 Output acknowledgements: `A` and `X`

```text
A,<cmd_id>,<t_on_us>,<t_off_us>
X,<cmd_id>,<reason>
```

`A` reports a finished pulse with the device-measured times, on its own clock, at which the output went on and off. `X` reports a pulse that was refused or failed; `reason` is one of `busy` (a pulse was still running), `range` (width outside the device's own limits), `channel` (no such output channel), `fault`, or another lower-case word, which the host records.

**D10. One outcome per pulse.** An output device that declares `ack=1` MUST answer every `pulse` command with exactly one `A` or `X` line carrying the command's `cmd_id`. *Reason:* the session reports the commanded and the delivered reward for every trial; a pulse with no outcome is logged as unresolved, never assumed to have happened (rule H8).

How a device times a pulse, and what it does when the host stops sending heartbeats or disappears mid-pulse, is the rig's business (owner, 2026-10-07 and 2026-10-09; ADR-0002, Rig runtime). The host enforces the safety envelope of the rig file (maximum width per pulse, minimum interval, maximum per session) before it sends a `pulse` (ADR-0002, Rig runtime).

### 4.6 Diagnostics: `E`

```text
E,<code>,<text>
```

`code` is a lower-case word (`a-z 0-9 _`, up to 16 characters); `text` is free printable text without `*` and may contain commas. A device MAY send `E` lines at any time. The host logs them as device warnings and never interprets them. Free text of any other kind, such as debug prints, breaks F1 and F3: the host counts it as corruption (rule H2), which spoils the session's integrity counters.

## 5. Commands from the host

Host commands are lower-case words, framed as in section 3 (with the checksum) and ended with LF.

| Command | Meaning |
|---|---|
| `hello` | answer with one `H` line (D1) |
| `start` | set every running total to 0, set the next `seq` to 0, begin the first window, stream |
| `stop` | stop streaming; SHOULD answer with `Z` |
| `beat` | heartbeat (rule H7) |
| `pulse,<cmd_id>,<channel>,<width_us>` | switch output `channel` on for `width_us` µs (uint32), then off; `cmd_id` (uint32) identifies the command in the answer |

A `start` while a stream is running starts a new stream. A device ignores a command it does not know (and MAY report it with an `E` line).

**D11. Checked commands.** A device that drives outputs MUST ignore a command whose checksum is missing or wrong. *Reason:* a corrupted width or channel number must never open a valve.

## 6. Session sequence

What the host does, in order. The times marked *default* are rig-file settings; the values given are proposed defaults, not measurements.

1. Open the port. Wait the rig file's `open_delay_ms` (default 0; boards that reset when the port opens need about their boot time).
2. Send `stop` and discard everything received so far.
3. Send `hello` and wait for the `H` line; repeat every 500 ms (default) until one arrives or 5 s (default) have passed, which is a fault before the session is armed. Check the `H` line against the rig file (rule H5).
4. When the session is armed, start sending `beat` to every device whose hello declares `hb` (rule H7).
5. Discard everything received so far, then send `start` (rule H4).
6. Read lines until the session ends (section 7).
7. Send `stop`, keep reading until the `Z` line or 500 ms (default), then stop the heartbeat and close the port.

## 7. What the host does with each line

### 7.1 Host rules

**H1. Reassembly.** The host MUST reassemble lines from however the bytes arrive, independent of USB packet and read boundaries, and MUST stamp each line with the session clock (`perf_counter_ns`) at the read that completed it, `t_host_ns`. *Reason:* USB delivers lines in arbitrary pieces, and a sample must not depend on how its bytes were split; the receive times map the device clock onto the session clock.

**H2. Rejected lines.** The host MUST NOT use a line that breaks F1 to F4 or the field rules of its type, and MUST count it by cause: `overflow` (F2), `crc_errors` (F3, also a missing checksum), `parse_errors` (anything else), and `unknown` for a well-formed line of an unknown type. Rejected lines stay in the raw-line log when it is on. *Reason:* corruption must be visible in the session's counters and never become motion.

**H3. Each sample once, in order.** For a sample with number s after the last accepted number p, let d = (s − p) modulo 2³². If d = 1 the sample is next; if 2 ≤ d < 2³¹, d − 1 samples were lost and the host MUST record them in the sample's `gap` and in the session counters (`seq_gaps`, `samples_lost`); if d = 0 or d ≥ 2³¹ the sample is a duplicate or older, and the host MUST discard it and count it (`seq_regressions`). *Reason:* the motion core uses each sample exactly once and in seq order (ADR-0001 R1; ADR-0002, Motion worker), and every loss is logged (ADR-0002, Gaps).

**H4. Stream start.** Before sending `start` the host MUST discard everything already received, and it MUST NOT accept `S` lines that arrive before it sends `start`. The first `S` line after `start` opens the stream; if its seq is n > 0, the host counts n samples as lost before it. *Reason:* lines still waiting in the driver's buffer, or a stream that an earlier session left running, must not enter a session, and losses at the start of a stream must be counted, not hidden.

**H5. Hello check.** Before arming, the host MUST compare the `H` line with the rig file: protocol name, major version 1, the device id if the rig file names one, `period_us`, and `n_axes` against the columns of the calibration matrix; it MUST also refuse a declared `hb` below 300 ms. Any mismatch MUST refuse to arm the session. *Reason:* see D1. A heartbeat timeout shorter than three of the host's 100 ms heartbeat periods (H7) would make the device close its outputs after an ordinary scheduling delay.

**H6. Device time.** The host MUST unwrap `t_us` into a 64-bit time: for consecutive accepted samples, t_dev(k) = t_dev(k−1) + Δ, with Δ = (t_us(k) − t_us(k−1)) modulo 2³², starting from the first sample's `t_us`. If Δ = 0 or Δ ≥ 2³¹ (about 35.8 minutes), the device clock went backward or the device restarted, and the host MUST fault the stream. For consecutive seq, if `dt_us` differs from Δ, the host MUST flag the sample and count it (`dt_mismatch`), and still use it, because its counts are real motion. The host MUST unwrap the device times of `L`, `F`, `Z` and `A` lines to the 64-bit value nearest a reference sample: t_dev(ref) + δ, with δ = (t − t_us(ref)) modulo 2³² read as a signed value from −2³¹ to 2³¹ − 1. The reference is the sample an event is assigned to (D9) for `L` and `F` lines, and the last accepted sample for `Z` and `A` lines; without a reference sample (a device without samples, or a stream in which none arrived), the times are recorded as sent. *Reason:* see D4 and D5; lick, frame-clock and pulse times must be on the same unwrapped clock as the samples. A wrap is ambiguous only after a silence longer than 2³¹ µs, far beyond any T_fault.

**H7. Heartbeat.** From arming until the session ends, the host MUST send `beat` at least every 100 ms to every device whose hello declares `hb`. *Reason:* the host can neither close a valve nor run any code when its own process is killed or hangs (ADR-0002, Validation 5). A device that watches for missing heartbeats can, and that protection is the rig's (ADR-0002, Rig runtime). The 100 ms period, with a device timeout of at least 300 ms, is the one in the 2026-10 experiment-data design.

**H8. Pulse outcomes.** `cmd_id` MUST be unique within a session, starting at 1 and increasing. For a device that declares `ack=1`, every pulse MUST end in exactly one outcome: done (`A`), refused or failed (`X`), or unresolved, when neither arrives within the pulse width plus the rig file's acknowledgement timeout (proposed default 100 ms). A late `A` after an unresolved outcome is logged and does not change it. *Reason:* see D10. For a device without acknowledgements, the outcome is the command alone (timing class `unreported`, section 8.4).

**H9. Guarantees recorded.** When it arms a session, the host MUST write each device's profile, guarantee flags, completeness and integrity levels, `seq_source` and `time_source` into the session record (section 8.3), MUST set `guarantees.stop_report` when the stream ends (true only if a `Z` line arrived), and MUST NOT report a better level than the one in force. *Reason:* a paper's claim about lost or corrupted samples must name the level of the device that produced the data.

### 7.2 The device sample the host derives

From every accepted sample the host derives one *device sample*. The link protocol to the motion worker (a separate specification) carries it; these are its contents.

| Field | Meaning | v1 profile | legacy-v0.3 profile (section 10) |
|---|---|---|---|
| `seq` | uint32 sample number, in stream order | the `S` line's seq | numbered by the host (L4) |
| `seq_source` | who numbered the sample | `device` | `host` |
| `t_dev_us` | integer µs on the device clock | unwrapped `t_us` (H6) | unwrapped field 0, or the session clock in µs with `time: "none"` (L5) |
| `dt_us` | the time `d` covers; longer than one window after a gap | t_dev_us minus the previous accepted sample's t_dev_us; for a stream's first sample, the `S` line's `dt_us` if its seq is 0, else (seq + 1) × `period_us`, flagged as an estimate | the difference of unwrapped field 0, and the declared period for the first line (flagged); with `time: "none"`, always the declared period (L5) |
| `raw` | counts per axis since the previous accepted sample | difference of each running total from the previous accepted sample (from 0 for a stream's first sample), in int32 arithmetic modulo 2³²: integers | `[field 7, field 8, field 9]` as parsed numbers |
| `d` | body-frame displacement `[fwd_cm, left_cm, dyaw_rad]` | `C · raw` | `C · raw` with the `C` of L3 |
| `dev_flags` | device flags, recorded unchanged | the `S` line's flags | 0 |
| `gap` | samples lost before this one, 0 when none | counted (H3, H4) | inferred (L5) |
| `t_host_ns` | session clock at receipt | H1 | H1 |

`C` is the rig file's calibration matrix, 3 rows by `n_axes` columns, in cm per count for the first two rows and radians per count for the third. The host evaluates d_i = Σ_j C_ij · raw_j in IEEE-754 double precision with j ascending, so that every run gives the same bits. Forward is along the heading, left is positive, and dyaw is positive counter-clockwise seen from above (ADR-0001 R1: yaw 0 looks down −Z, left is −X). The calibration also fixes the signs of the sensor axes.

Because a device sample carries a displacement, an error in `dt_us` never moves the avatar: the avatar ends up where the counts put it. Time errors affect only time-based quantities: timers, speeds and the display's interpolation.

## 8. Guarantee levels

A stream that follows this protocol gives every guarantee below. A profile that lacks a field gives fewer, and the session says so.

### 8.1 Guarantee flags

| Flag | True when | When false, the host instead | What is lost |
|---|---|---|---|
| `hello` | the device answered `hello` with a matching `H` line (H5) | takes identity, period and axis count from the rig file alone | a swapped device or a changed rate goes unnoticed |
| `device_seq` | samples carry the device's own sample number (D3) | numbers accepted samples itself, from 0 per stream (`seq_source: host`) | losses between the device and the host are not counted from seq |
| `device_time` | samples carry a device microsecond clock (D4) | uses the session clock at receipt as t_dev (`time_source: host`) | timers and gap inference ride on USB and scheduler jitter |
| `window_dt` | samples carry `dt_us` (D5) | takes `dt_us` from t_dev differences, and the declared period for a stream's first sample (flagged) | window contiguity is not checked |
| `checksum` | lines carry a verified CRC-8 (F3) | accepts a line on its field count and number syntax alone | a corrupted digit that still forms a number becomes motion |
| `running_totals` | counts are running totals (D6) | uses each line's counts as that sample's own displacement | the motion of a lost line is lost for good |
| `stop_report` | the device answered `stop` with `Z` (section 4.3) | nothing | losses after the last received sample of a stream are not counted |

### 8.2 Levels and what a paper can claim

Completeness follows from `device_seq` and `device_time`; integrity follows from `checksum`.

| Level | Requires | A paper can claim | It cannot claim |
|---|---|---|---|
| completeness `counted` | `device_seq` | every sample the device produced from `start` up to the last sample received (up to `stop` if `stop_report`) was used exactly once and in order, or is counted as lost at its position in the stream. With `running_totals`, lost samples cost time resolution but no displacement: the next received sample applies their motion | when within a gap the lost motion happened |
| completeness `inferred` | `device_time` without `device_seq` | every sample that reached the host was used exactly once, in arrival order; losses were inferred where the device clock jumped by more than 1.5 declared periods | that no sample was lost: inference assumes the device keeps its declared period, so a loss that coincides with a change of period is missed; the motion of lost samples is missing unless `running_totals` |
| completeness `received` | neither | every sample that reached the host was used exactly once, in arrival order | anything about samples lost before the host; device timing (times are host receive times) |
| integrity `crc8` | `checksum` | lines that failed a CRC-8 check were rejected and counted; a corrupted line passes with a probability of about 1 in 256 when the corruption is random | that no corrupted line was used at all |
| integrity `parse-only` | no `checksum` | lines with the wrong field count or a malformed number were rejected and counted | that no corrupted sample was used |

Which levels are acceptable for paper data is a project decision outside this specification; the level actually in force is always recorded. No level says anything about display timing, which the frame log covers.

### 8.3 Session record fields

The host writes, for each device, under `devices.<device key from the rig file>` in `session.json`:

| Field | Values | Set from |
|---|---|---|
| `profile` | `v1`, `legacy-v0.3` | rig file |
| `hello` | the parsed `H` line (protocol, version, device_id, period_us, n_axes, keys), or `null` | H5 |
| `guarantees` | object with the seven flags of section 8.1, each `true` or `false` | profile, hello and, for `stop_report`, the end of the stream |
| `completeness` | `counted`, `inferred`, `received` | section 8.2 |
| `integrity` | `crc8`, `parse-only` | section 8.2 |
| `seq_source` | `device`, `host` | `guarantees.device_seq` |
| `time_source` | `device`, `host` | `guarantees.device_time` |
| `counters` | `lines`, `samples`, `seq_gaps`, `samples_lost`, `seq_regressions`, `crc_errors`, `parse_errors`, `overflow`, `unknown`, `dt_mismatch`, `late_events`, `ignored` (legacy only) | H2 to H6, D9 |
| `output_timing` | `hardware`, `software`, `unreported` (output devices only) | section 8.4 |

Which missing field leads to which record values:

| Missing from the stream | Record fields that show it |
|---|---|
| hello | `hello: null`, `guarantees.hello: false` |
| device sequence number | `guarantees.device_seq: false`, `seq_source: host`, `completeness: inferred` or `received` |
| device time | `guarantees.device_time: false`, `time_source: host`, `completeness: received` if the sequence number is missing too |
| window length | `guarantees.window_dt: false` |
| checksum | `guarantees.checksum: false`, `integrity: parse-only` |
| running totals (per-sample counts instead) | `guarantees.running_totals: false` |
| stop report | `guarantees.stop_report: false` |

### 8.4 Output timing classes

| `output_timing` | When | What the session can state about a pulse |
|---|---|---|
| `hardware` | the output device reports the on and off times it measured on its own clock (a serial device with its `A` lines) | the on and off times the device measured on its own clock; how the device timed the pulse is the rig's |
| `software` | the host times the pulse itself, as the built-in NI-DAQ analog-output adapter does | the host's times of the on and off writes; the valve line itself is measured only if the rig wires a loopback |
| `unreported` | a serial output device without acknowledgements (`ack=0`) | the command and its send time only |

## 9. Rules, reasons and tests

Each rule is checked by tests named after it: `SIM-` tests belong to the reference simulated device in `test/e2e/sim`, whose conformance checker reads a captured stream and reports every rule it breaks; `RDR-` tests belong to the serial reader's tests in `test/backend/runtime`; `LEG-` tests belong to the legacy-v0.3 adapter's tests there. The L rules describe the legacy adapter alone, so only its tests check them. A test's name carries its id, for example `test_rdr_h3_seq_gap_counted`.

| Rule | MUST | Reason (short) | Tests |
|---|---|---|---|
| F1 | printable-ASCII records, `*CC`, LF, optional CR | resynchronise at the next LF; readable raw log | SIM-F1, RDR-F1 |
| F2 | at most 254 bytes per line | bounded reader buffer | SIM-F2, RDR-F2 |
| F3 | CRC-8/SMBUS over the record | corruption never becomes motion or a command | SIM-F3, RDR-F3 |
| F4 | comma-separated decimal fields, no spaces | one parse in every language | SIM-F4, RDR-F4 |
| D1 | answer every `hello` with one `H` | the right device and calibration before arming | SIM-D1, RDR-D1 |
| D2 | one `S` per period, also without motion | timers fire on samples; silence means a fault | SIM-D2, RDR-D2 |
| D3 | seq from 0 per stream, +1 per sample, never renumbered | exact gap accounting | SIM-D3, RDR-D3 |
| D4 | free-running µs clock at window end, never reset in a stream | integrals and timers on device time | SIM-D4, RDR-D4 |
| D5 | contiguous windows; `dt_us` = window length | every count in one window; first window's length | SIM-D5, RDR-D5 |
| D6 | running totals of raw integer counts | calibration in the rig file; exact sums; lost lines keep their motion | SIM-D6, RDR-D6 |
| D7 | flags present; set only when true; reserved bits 0 | device-only conditions reach the data | SIM-D7, RDR-D7 |
| D8 | `S`, `L`, `F` only between `start` and `stop` | no stale samples in a new stream | SIM-D8, RDR-D8 |
| D9 | events in time order, before their window's `S` | events assigned per sample without reordering | SIM-D9, RDR-D9 |
| D10 | with `ack=1`, exactly one `A` or `X` per pulse | commanded versus delivered reward | SIM-D10, RDR-D10 |
| D11 | output devices ignore commands with a bad checksum | a corrupted width never opens a valve | SIM-D11 |
| H1 | reassemble across reads; stamp `t_host_ns` | samples independent of byte splits | RDR-H1 |
| H2 | never use a rejected line; count it by cause | corruption visible, never motion | RDR-H2 |
| H3 | each sample once, in seq order; gaps and regressions counted | ADR-0001 R1; ADR-0002 Gaps | RDR-H3 |
| H4 | discard input before `start`; count losses before the first sample | no stale backlog; losses at the start counted | RDR-H4 |
| H5 | hello checked against the rig file, `hb` at least 300 ms; mismatch refuses to arm | see D1; a heartbeat timeout that tolerates scheduling delays | RDR-H5 |
| H6 | unwrap `t_us` and event times; fault on a backward clock; count `dt_mismatch` | see D4, D5; events on the samples' clock | RDR-H6 |
| H7 | `beat` every 100 ms or faster to devices with `hb` | rig-side protection when the host dies | SIM-H7 |
| H8 | unique `cmd_id`; exactly one outcome per pulse | see D10 | RDR-H8 |
| H9 | profile, flags and levels in the session record | claims name the level in force | RDR-H9 |
| L1 | send the rig file's init lines after its delay; discard earlier input | the v0.3 device stays silent until initialised; rig settings live in the rig file | LEG-L1 |
| L2 | accept the lines v0.3 accepted, except non-finite numbers and a field 0 that is not a clock; count skips and rejects; keep the raw-line log | nothing v0.3 used is lost; without a checksum, only the raw log lets a line be re-examined | LEG-L2 |
| L3 | forward = field 8 × k, left = field 7 × k, dyaw = field 9 × y | the avatar moves as v0.3's mapping moved it | LEG-L3 |
| L4 | host sequence numbers, from 0 per stream | the stream carries no confirmed sample number | LEG-L4 |
| L5 | field 0 as a µs clock (or the session clock); gaps inferred; clock checked against the period | timers on a device clock where one exists; a wrong clock or period is caught | LEG-L5 |
| L6 | field 10 as the lick value, with onsets and offsets | licks are measured in the planned experiments | LEG-L6 |
| L7 | profile, flags, levels and quality summary recorded | see H9 | LEG-L7 |

The `SIM-` checker is also how a rig builder tests a device: capture its output to a file and run the checker on it.

## 10. Profile legacy-v0.3

This profile reads the device stream that three-maze v0.3's hallway01, hallway02 and hallway04 experiments read (`experiments/hallway04_experiment.py:329-381`; hallway01 and hallway02 hold copies of the same parser), so that existing rigs keep working without a firmware change. The firmware behind that stream is not in the repository; everything below comes from the code that reads it and from the simulated device in the end-to-end test bench, which models it (`test/e2e/sim/threemaze_sim/teensy.py:1-31`). Facts that only the real device can confirm are listed in section 10.6.

It does not cover the other 13-field stream in the repository, the one started with `START,50,0` by `experiments/standalone_hallway_experiment.py:174` and `experiments/autonomous_hallway_experiment.py:154`, whose fields are two sensors' displacements, surface quality and running totals (`experiments/standalone_hallway_experiment.py:271-321`). Both streams have 13 numeric fields, so nothing in a line tells them apart: the rig file must name the right profile, and the first real-device check confirms the fields with deliberate movements and lick taps.

### 10.1 Host to device

v0.3 opens the port (115,200 baud, which a native USB serial device such as a Teensy ignores; `hallway04_experiment.py:157`), waits 2 s (`:169`) and sends the line `10000,50,10,1` with LF (`:172-173`). It sends nothing else and stops the stream by closing the port. What the four numbers mean is not documented in the repository; the simulated device reads the second as the sample period in ms and the fourth as a run flag (`teensy.py:6-9`), which is an assumption of the simulator.

**L1. Init lines from the rig file.** The adapter MUST send the rig file's `init_lines` after its `init_delay_ms` (defaults: the single line `10000,50,10,1` and 2,000 ms, as v0.3), discarding everything received before the first init line, and MUST take the init lines, the init delay, the port and the calibration from the rig file only. *Reason:* the v0.3 device stays silent until it receives the init line (`teensy.py:5`), and a rig's settings belong in its rig file.

### 10.2 Lines the adapter accepts

v0.3 decodes each line as UTF-8 and strips surrounding white space (`hallway04_experiment.py:266`). It skips a line that contains any of `[CMD]`, `[CONFIG]`, `[INFO]`, `[START]`, `[RUNNING]`, `[STOP]`, `Time(us)`, `Data Header`, `Data Start`, `---` or `===` (`:341-346`), a line that does not start with a digit (`:349`), and a line with fewer than 13 comma-separated fields (`:352-354`); fields after the 13th are ignored. A field that fails to parse skips the line (`:379-381`).

**L2. Same lines as v0.3, never a non-finite number.** Of the lines that arrive after the first init line, the adapter MUST accept exactly the lines v0.3 accepted, with two exceptions: it MUST reject a line in which any number is not finite (`nan` and `inf` parse with Python's `float()`, and v0.3 would have moved the avatar by NaN from then on), and, when field 0 is used as a clock (L5), a line whose field 0 is not an unsigned integer. It MUST count skipped and rejected lines by cause (`ignored` for the skip patterns and non-digit starts, `parse_errors` for the rest) and MUST keep the raw-line log on for every legacy session. *Reason:* no data that v0.3 used is lost; without a checksum, the raw-line log is the only way to re-examine a suspicious line later.

### 10.3 Fields

Fields are numbered from 0. The v0.3 parser is `hallway04_experiment.py:358-374`; the simulated device sends sample k as `k·P,0,c,P,0,c,P,0,c,0,0,0,k` with P the period in µs and c the forward counts of that sample (`teensy.py:14-17`, `:171`).

| Field | v0.3 name | v0.3 parses as | What v0.3 does with it | Simulated device | Profile use |
|---|---|---|---|---|---|
| 0 | `timestamp` | text, unparsed (`:358`) | logs it as "Teensy timestamp (microseconds)" (`:661`, `:673`) | k·P: a µs clock restarting at 0 with each init line | device time, if the rig file says it is a µs clock (L5) |
| 1 | `leftSensor.dx` | float | nothing | 0 | recorded only |
| 2 | `leftSensor.dy` | float | nothing | c | recorded only |
| 3 | `leftSensor.dt` | float | nothing | P | recorded only (meaning unconfirmed) |
| 4 | `rightSensor.dx` | float | nothing | 0 | recorded only |
| 5 | `rightSensor.dy` | float | nothing | c | recorded only |
| 6 | `rightSensor.dt` | float | nothing | P | recorded only (meaning unconfirmed) |
| 7 | `x` | float | sideways: velocity x·0.0349/DT, clipped to ±100 (`:532-536`); positive moves left (`:548-549`) | 0 | `raw[0]`: left = field 7 × k |
| 8 | `y` | float | forward: velocity y·0.0349/DT, clipped to ±100 (`:537-541`) | c | `raw[1]`: forward = field 8 × k |
| 9 | `theta` | float | turn: heading += theta × 0.05 rad (`:287-289`); positive is counter-clockwise from above | 0 | `raw[2]`: dyaw = field 9 × yaw factor |
| 10 | `water` | int | the lick signal: logged in every data row (`:672`), not used by the task | 0 | lick channel 0 (L6) |
| 11 | `direction` | float | nothing | 0 | recorded only |
| 12 | `frameCount` | int | forwarded to the renderer (`:305`), which does not use it | k | recorded only (section 10.6) |

v0.3's data files record fields 0, 7, 8 and 10 for each logged row, but not field 9: their `theta` column is the integrated heading (`hallway04_experiment.py:666-674`).

### 10.4 Motion

**L3. Mapping.** The adapter MUST derive each sample's displacement as forward = field 8 × k, left = field 7 × k and dyaw = field 9 × y, that is, `C = [[0, k, 0], [k, 0, 0], [0, 0, y]]` applied to `raw = [field 7, field 8, field 9]`, with k (cm per count) and y (radians per count) from the rig file. Defaults are v0.3's: k = 0.0349 (`hallway04_experiment.py:84`; the same in `hallway01_experiment.py:84` and `hallway02_experiment.py:81`, while `hallway_experiment.py:75`, `standalone_hallway_experiment.py:98` and `autonomous_hallway_experiment.py:94` use 0.0364) and y = 0.05 (`:288`). *Reason:* a legacy session then moves the avatar as v0.3's mapping did, sample by sample.

What changes against v0.3, by design, and is recorded with the session:

- **Displacements, not velocities.** v0.3 turned counts into a velocity with an assumed DT of 1/20 s (`:81`, `:532-541`), which the renderer then applied per frame; the adapter passes the displacement itself. Where v0.3's clip did not act, the two agree: v0.3's velocity × DT equals field × k.
- **No clip.** v0.3 clipped the sideways and forward velocities (fields 7 and 8) to ±100 units/s each (`:80`, `:532-541`), that is, at k = 0.0349 and DT = 1/20 s, beyond about 143 counts per sample; it did not clip the turn (`:552`). The adapter applies no clip: the project owner decided on 2026-10-09 that v1 has no running-speed clamp, since a clamp would make the gain fall below 1 during fast runs, and that each session records the highest speed reached instead (three-maze-notes decision log DEC-035).
- **Heading.** v0.3 added each sample's turn to the heading before turning that sample's displacement (`:285-289`, `:545`), and the renderer integrated a second copy of the heading (ADR-0001, Context). The motion core is the only heading integrator and turns each sub-step by the heading at its midpoint (ADR-0001 R1).

### 10.5 Sequence, time, licks and guarantees

**L4. Host sequence numbers.** The adapter MUST number accepted lines itself: 0 for the first accepted line after the init line, +1 per accepted line, modulo 2³² (`seq_source: host`). *Reason:* the stream carries no sample number; field 12 might, but that is unconfirmed (section 10.6).

**L5. Time.** With the rig-file setting `time: "us_clock"` (the default, since v0.3 labels field 0 as microseconds, `:673`), the adapter MUST unwrap field 0, taken modulo 2³², as a uint32 µs clock with rule H6, use the difference to the previous accepted line as the sample's `dt_us` (the declared period for the first line, flagged), and infer a gap wherever that difference exceeds 1.5 declared periods: ⌊(2 · difference + period) / (2 · period)⌋ − 1 samples (the ratio rounded half up in integer arithmetic, so that every language counts the same), recorded in `gap` and counted. It MUST check the clock: when the 100th accepted line arrives, if the median of the 99 differences so far differs from the declared period by more than 5 % (proposed thresholds), it faults the stream. With `time: "none"` it MUST use the session clock at receipt as the time and the declared period as `dt_us`, and infers no gaps. The declared period comes from the rig file (default 50,000 µs: v0.3's DT, `:81`). *Reason:* timers need a device clock wherever one exists, and a mismatch between field 0 and the declared period means one of them is wrong. Half a period of jitter is not a loss.

**L6. Licks.** The adapter MUST record field 10 of every accepted line as that sample's lick value, and an onset (value changes from 0 to non-zero) or offset (from non-zero to 0) at that sample's device time; the value before the first accepted line counts as 0. *Reason:* v0.3 logged field 10 as the hardware lick signal (`:672`), and lick measures are part of the planned experiments; the edge time is only as fine as the sample period, unlike v1's `L` lines.

**L7. Guarantees.** The adapter MUST record `profile: legacy-v0.3` and these flags: `hello: false`, `device_seq: false`, `device_time: true` with `time: "us_clock"` and `false` with `time: "none"`, `window_dt: false`, `checksum: false`, `running_totals: false`, `stop_report: false`. The levels follow from section 8: completeness `inferred` (or `received` with `time: "none"`), integrity `parse-only`. The session's quality summary states "legacy-v0.3: device-side losses only inferred from device time; no checksum" with `time: "us_clock"`, and "legacy-v0.3: device-side losses undetectable; no checksum" with `time: "none"`. *Reason:* rule H9.

### 10.6 Facts to confirm on the real device

These come from the repository's code and its simulator, not from the device. The first real-device check measures them; until then the adapter relies only on what v0.3 relied on (fields 0, 7, 8, 9, 10).

- Whether field 0 is a microsecond clock, how wide it is (the 2³² wrap is assumed) and the real sample period.
- Whether fields 3 and 6 are window lengths, and what fields 1, 2, 4, 5 and 11 mean.
- Whether field 12 increases by exactly 1 per sample. If it does, a later version of this profile may use it as a device sequence number.
- That fields 7, 8 and 9 are integers (the simulated device sends integers; v0.3 parses floats).
- The signs of fields 7 to 9, with deliberate movements, and field 10, with lick taps.

## 11. Golden lines

These lines and their results are normative test vectors: the reference device's conformance checker and the reader's tests use them as written. Lines are shown without their CR and LF.

### 11.1 v1, valid

The motion device of section 2 (`n_axes` 4, period 4,000 µs, a stream just started):

| Line | Result |
|---|---|
| `hello*92` | host command: hello |
| `H,threemaze-device,1.0,ball-01,4000,4,fw=demo-1.2,flags=1,lick=1,fclk=1*D6` | hello: version 1.0, device_id `ball-01`, period_us 4000, n_axes 4, keys `fw=demo-1.2`, `flags=1`, `lick=1`, `fclk=1` |
| `start*3F` | host command: start |
| `S,0,1000000,4000,0,12,-1,35,3*37` | seq 0, t_dev_us 1000000, dt_us 4000 (the line's own, first sample), raw [12, −1, 35, 3], dev_flags 0, gap 0 |
| `L,0,1002500,1*D5` | lick channel 0 onset at 1002500; assigned to seq 1 |
| `S,1,1004000,4000,0,22,-1,65,5*A2` | seq 1, t_dev_us 1004000, dt_us 4000, raw [10, 0, 30, 2], gap 0 |
| `F,1,1006100*71` | frame-clock edge 1 at 1006100; assigned to seq 2 |
| `S,2,1008000,4000,1,-2026,6,65,5*F2` | seq 2, t_dev_us 1008000, dt_us 4000, raw [−2048, 7, 0, 0], dev_flags 1 (count_incomplete), gap 0 |
| `S,5,1020000,4000,0,-2010,6,90,7*F3` | seq 5, gap 2 (seq 3 and 4 lost), t_dev_us 1020000, dt_us 12000, raw [16, 0, 25, 2] (includes the motion of seq 3 and 4); `dt_us` is not compared with Δ because the seq are not consecutive |
| `stop*A5` | host command: stop |
| `Z,6,1022000*9D` | the stream had 6 samples: 4 received, 2 counted as lost; `stop_report: true` |

Wraps, each pair from the middle of a stream of the same device:

| Line | Result |
|---|---|
| `S,41,4294966296,4000,0,2147483647,0,1,0*17` | seq 41, t_us 4294966296 |
| `S,42,3000,4000,0,-2147483647,0,2,0*09` | seq 42, Δ = 4000 across the clock wrap (t_dev_us = previous + 4000), dt_us 4000, raw [2, 0, 1, 0] across the int32 wrap of axis 0 |
| `S,4294967295,2500000,4000,0,0,0,0,0*51` | seq 4294967295 |
| `S,0,2504000,4000,0,0,0,0,0*D0` | seq 0 directly after 4294967295 without a `start` in between: next sample, gap 0 |

Output device (`out=1`, `ack=1`, heartbeat timeout 300 ms) and diagnostics:

| Line | Result |
|---|---|
| `H,threemaze-device,1.0,valve-01,0,0,out=1,ack=1,hb=300*2C` | hello: device_id `valve-01`, no samples, 1 output, acknowledges pulses, heartbeat timeout 300 ms |
| `beat*D7` | host command: heartbeat |
| `pulse,1,0,70000*63` | host command: pulse 1 on channel 0 for 70000 µs |
| `A,1,1010200,1080200*CC` | pulse 1 done; device-measured width 70000 µs |
| `pulse,2,0,900000*BF` | host command: pulse 2 for 900000 µs |
| `X,2,range*AD` | pulse 2 refused: beyond the device's own limit |
| `E,sensor,left sensor did not answer*98` | device warning `sensor`: "left sensor did not answer" |

Single lines of the motion device, each read on its own (not as part of the stream above):

| Line | Result |
|---|---|
| `S,1,1004000,4000,0,22,-1,65,5*a2` | accepted, with the same result as the seq 1 line above: checksum digits may be lower case |
| `S,0,1000000,4000,2,12,-1,35,3*8D` | accepted: dev_flags 2 (no_tracking), a bit that the hello's `flags=1` does not declare: the host does not compare flags with the hello's `flags` key |
| `S,0,1000000,4000,4,12,-1,35,3*44` | accepted: reserved bit 2 set; recorded in dev_flags, otherwise ignored |

### 11.2 v1, rejected

For the device above (`n_axes` 4):

| Line | Counted as | Why |
|---|---|---|
| `S,1,1004000,4000,0,22,-1,95,5*A2` | `crc_errors` | 65 corrupted into 95 in transit; the checksum belongs to the original line |
| `S,1,1004000,4000,0,22,-1,65,5` | `crc_errors` | no checksum |
| `S,0,1000000,4000,0,12,-1,35*0C` | `parse_errors` | 3 totals for 4 axes |
| `S,0,1000000,4000,0,12,-1,35,3,4*4C` | `parse_errors` | 5 totals for 4 axes |
| `S,7,1028000,4000,0,1.5,2,3,4*60` | `parse_errors` | not an integer |
| `S,7,1028000,0,0,1,2,3,4*5D` | `parse_errors` | `dt_us` 0 |
| `S,0,1000000,4000,256,12,-1,35,3*DE` | `parse_errors` | flags above 255 |
| `S, 7,1028000,4000,0,1,2,3,4*1F` | `parse_errors` | a space in a field |
| `L,1,1002500,1*CA` | `parse_errors` | lick channel 1; the hello declares one lick channel (`lick=1`), channel 0 (section 4.4) |
| `Q,1,2*F8` | `unknown` | valid checksum, unknown type; ignored |
| any line of more than 254 bytes | `overflow` | F2; the reader resumes after the next LF |

### 11.3 legacy-v0.3

Rig-file defaults: k = 0.0349 cm per count, y = 0.05 rad per count, period 50,000 µs, `time: "us_clock"`. Accepted lines, in order, as the first lines after the init line:

| Line | Result |
|---|---|
| `50000,0,16,50000,0,16,50000,0,16,0,0,0,1` | seq 0, t_dev_us 50000, dt_us 50000 (declared period, flagged), raw [0, 16, 0], d = [16·k, 0, 0] (forward 0.5584 cm), lick 0 |
| `100000,0,16,50000,0,16,50000,0,16,0,0,0,2` | seq 1, t_dev_us 100000, dt_us 50000, d = [16·k, 0, 0] |
| `150000,3,11,50000,4,13,50000,5,12,-3,1,0,3` | seq 2, dt_us 50000, raw [5, 12, −3], d = [12·k, 5·k, −3·y] (forward 0.4188 cm, left 0.1745 cm, dyaw −0.15 rad), lick 1: onset at 150000 |
| `300000,0,16,50000,0,16,50000,0,16,0,1,0,6` | seq 3, dt_us 150000, gap 2 inferred (150000 > 1.5 × 50000; ⌊350000 / 100000⌋ − 1), d = [16·k, 0, 0], lick 1 |
| `450000,0,16,50000,0,16,50000,0,16,0,0,0,9,77` | seq 4, gap 2 inferred, lick 0: offset at 450000; the 14th field is ignored, as in v0.3 |

The values in centimetres and radians are the products in IEEE-754 double precision (for example −3 × 0.05 is −0.15000000000000002); tests compare the products, not the rounded decimals shown here.

Skipped or rejected:

| Line | Counted as | Why |
|---|---|---|
| `[INFO] streaming` | `ignored` | skip pattern, as v0.3 |
| `Time(us),left_dx,left_dy,left_dt,right_dx,right_dy,right_dt,x,y,theta,water,direction,frameCount` | `ignored` | skip pattern (a header line), as v0.3 |
| `-50000,0,16,50000,0,16,50000,0,16,0,0,0,1` | `ignored` | does not start with a digit, as v0.3 |
| `350000,0,16,50000,0,16,50000,0,16,0,1,0` | `parse_errors` | 12 fields, as v0.3 |
| `400000,0,16,50000,0,16,50000,nan,16,0,1,0,8` | `parse_errors` | not finite (v0.3 accepted it) |
| `400000,0,16,50000,0,16,50000,0,16,0,1.0,0,8` | `parse_errors` | field 10 is not an integer, as v0.3 (`int()`) |

## 12. Notes for device builders (non-normative)

- **Flush every line.** A Teensy's USB serial port holds a partly filled USB packet for a few milliseconds unless the sketch calls `Serial.send_now()` after each line (the 2026-10 motion-core design gives 3 to 5 ms; not measured here). Other USB serial stacks have similar settings.
- **Take the time and the totals together.** Latch `t_us` and the running totals in the same timer interrupt (for example a Teensy `IntervalTimer`), then format and send the line outside it. Read each sensor's motion registers once per window, add them to the 32-bit totals, and let the totals wrap.
- **No debug prints.** Use `E` lines; anything else counts as corruption.
- **Rates.** The reference device and the reader are tested at 20, 250 and 1,000 samples per second. At 1,000 samples per second a 4-axis `S` line of about 40 bytes is about 40 kB/s, far below what a full-speed USB serial link carries.
- **Boards that reset when the port opens.** Many Arduino-type boards reboot when the host opens the port; set `open_delay_ms` in the rig file to their boot time, and the hello retries cover the rest.
- **Outputs.** Time pulses with a hardware timer if you can, report the measured on and off times with `A`, close the output on `stop`, on USB disconnect and, if you declare `hb`, when heartbeats stop. three-maze cannot do any of this for you once its own process has died.
- **Testing a device.** Capture its output to a file and run the reference device's conformance checker on it (section 9).

## 13. Versioning

The version in the hello is `<major>.<minor>`. A minor version only adds optional keys, optional line types and flag bits; a host accepts any minor version of a major version it knows, ignores unknown keys and line types (H2, `unknown`) and records them. Changing or removing a MUST, or the meaning of a field, needs a new major version, a new profile and a new document. This document is version 1.0.

## 14. Sources

- Owner decisions: device firmware is user code, and three-maze owns this specification, an adapter for the v0.3 stream and a simulated reference device (2026-10-09); how a rig times a pulse in hardware, and protection against the rig runtime process dying, are the rig's (2026-10-07, 2026-10-09); phase 1 reads the `v1` and `legacy-v0.3` profiles only, and a configurable text-line profile and user-written drivers follow in phase 2 (2026-10-09; three-maze-notes decision log DEC-039, which keeps the customisable device format promised on 2026-10-06 in DEC-008).
- [ADR-0001](../adr/0001-player-mover.md): Context (v0.3's gain g = (rAF rate / 60) · (T_dev / 50 ms)); Terms; R1 (samples in seq order, each once; device dt; yaw convention).
- [ADR-0002](../adr/0002-task-engine-location.md): Motion worker; Clock and order (timers on device time; non-motion inputs per sample with their dispatch seq); Rig runtime (safety envelope; protection against the runtime dying is rig-side); Gaps; Validation 5.
- `experiments/hallway04_experiment.py` at b96ad72: `:80-84` (clip, DT, cm per count), `:157`, `:169-173` (baud rate, init delay and line), `:266` (decoding), `:285-289` (heading before displacement), `:329-381` (parser; skip rules `:341-354`, fields `:358-374`), `:525-561` (velocity mapping), `:661-674` (data row).
- `experiments/standalone_hallway_experiment.py:174`, `:271-321` and `experiments/autonomous_hallway_experiment.py:154` (the other 13-field stream).
- `test/e2e/sim/threemaze_sim/teensy.py:1-31`, `:171` and `test/e2e/sim/threemaze_sim/config.py:14-18` (the simulated v0.3 device).
- 2026-10 design review, outside the repository: the motion-core design (serial reader thread with CRC-8 and uint32 unwrapping; `Serial.send_now()`) and the experiment-data design (sample and event lines with a `*CC` checksum, a 100 ms heartbeat with a 300 ms device timeout, device-measured pulse acknowledgements). This specification departs from both in two places: counts are running totals instead of per-window counts (D6), and lick and frame-clock data are separate event lines instead of fields of every sample (section 4.4).
- CRC-8/SMBUS parameters: the "Catalogue of parametrised CRC algorithms" (reveng.sourceforge.io/crc-catalogue); check value 0xF4 verified with the reference code above.
