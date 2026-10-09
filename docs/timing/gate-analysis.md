# Week-6 gate: analysis pre-specification

- Status: **Proposed** (2026-10-09). The owner approves it under decision D18 by 2026-11-13, before
  any gate data exist (REN-22, week 6). After approval it changes only by a dated amendment below,
  never after the gate sessions have been recorded.
- Version: `gate-analysis 1`, the `SPEC_VERSION` of the code that implements it.
- Implements: [ADR-0003](../adr/0003-render-worker-priority.md) Decision 2 (lines 52-55) and
  Validation 4 (line 79); plan item REN-13.
- Code: `tools/timing/gateCounting.ts` (the rules and statistics, the only implementation, used
  for the per-session QC summaries too), `tools/timing/gate.ts` (the command line),
  `test/frontend/gateCounting.test.ts` (fixtures with hand-computed answers).

ADR-0003 fixes how missed frames are counted and when the render worker is promoted. It leaves
open how the 95% confidence interval (CI) is computed and how late intervals without an
attribution count. A borderline verdict can depend on both, so this document fixes them, and every
other choice the analysis needs, before the data are seen. Section 9 lists what the owner approves.

## 1. Usage

```sh
npm run timing:gate -- <session folder> [<session folder> ...] [--out gate-report.json]
```

It prints one summary line per session (the QC summary), the pooled estimates and the verdict, and
writes everything as JSON with `--out`. Exit code 0 means the analysis ran, whatever the verdict;
2 means bad arguments or unreadable input. The script runs `node --experimental-strip-types`,
which works from Node 22.6 (this PC: 22.16.0) and is the default from Node 22.18 (decision D4).

## 2. Inputs

All times are on the stimulus window's `performance.now()` clock, in milliseconds (columns and
fields ending in `_ms`) or in microseconds (ending in `_us`, as the link protocol carries times:
DPR-05a, integer microseconds); either is read as milliseconds. The frame log starts at renderer
ready (ADR-0003 1b: no compile or upload after ready).

| File | Content | Required |
|---|---|---|
| `frames.tsv` | one row per rendered frame, tab-separated, a header row, `#` comment lines. Columns used: `frame` (the frame index: one more for each rendered frame, so a jump means records were lost), `raf_ms` or `raf_us` (the rAF timestamp), `entry_ms` or `entry_us` (`performance.now()` at callback entry), and optionally `exit_ms` or `exit_us` (at callback exit), `hidden`, `context_lost`, `post_ready_rise` (each `1` if it happened at any time since the previous frame). Other columns are ignored. An incomplete last line (a file still being written) is dropped and reported; any other damaged line is an error. | yes |
| `longtasks.jsonl` | one JSON object per line: `type` (`longtask`, `long-animation-frame`, `handler` for the app's timed handlers, `trace` for main-thread tasks from the Chromium trace), `start_ms` and `duration_ms` (or `start_us` and `duration_us`), optional `name`. An incomplete last line is dropped and reported (an entry may be missing); any other damaged line is an error. | yes for the gate (a session without it is not valid) |
| `attribution.jsonl` | from the attribution step (REN-15): `{"frame": N, "class": C}` for the late interval that ends at frame N, with C one of `main-thread`, `gpu`, `clock`, `unattributed`. It covers the late intervals of both estimates. An incomplete last line is dropped and reported. | no: without it every late interval is unattributed |

This section is the file format that DPR-17 writes (its acceptance: "REN-13 reads the files
without conversion"); REN-11 and REN-12 produce the fields.

## 3. Counting (ADR-0003 Decision 2, line 53)

For each session:

1. **Excluded intervals.** The interval that ends at a frame flagged `hidden` or `context_lost` is
   left out of every count, and so is an interval across a jump in the frame index (frame-log
   records were lost, so how many frames the display missed there is unknown; counting it would
   turn lost records into missed frames). Such a session is not valid for the gate (section 6).
2. **Period.** P is the median of the session's rAF-timestamp intervals (excluded intervals left
   out). The same P is used for both estimates. (The prototype behind ADR-0003 Evidence 1,
   `.claude/paper-review/proto/rendering/bench.mjs:21-28`, took each series' own median; both were
   17.7 ms in `results/worker-high-100.json`. One P per session keeps the two estimates on the same
   frame clock.)
3. **Late and missed.** An interval longer than 1.5 P is late and counts round(interval / P) - 1
   missed frames. An interval of exactly 1.5 P is not late.
4. **Expected frames** are rendered plus missed: the number of intervals counted plus their missed
   frames, per estimate.
5. **Two estimates.** The *low* estimate uses the rAF timestamps, the *high* estimate the callback
   entry times. rAF timestamps under-read a stall (89.2 against 118.1 ms in Evidence 1, ADR-0003
   line 103), and the short intervals after a stall are not credited, so the entry count is the
   larger.
6. **Rates** are missed frames per 1,000 expected frames.
7. **Check.** The low count equals the net frame deficit, elapsed time / P minus the number of
   intervals, within 1 per stall (ADR-0003 Validation 4). Each session summary reports the deficit.

## 4. Attribution and G1

Each late interval has one class, from the attribution step (REN-15): `main-thread`, `gpu`,
`clock` or `unattributed`. ADR-0003 (line 54) counts only main-thread intervals for G1 and excludes
GPU-process and frame-clock intervals.

- **G1** is the rate of missed frames in late intervals attributed to the main thread, as a low
  and a high estimate.
- **Unattributed intervals (proposed, D18 a).** They are a separate class. The primary analysis
  does not count them. A **sensitivity analysis** repeats every step with them counted as
  main-thread. The verdict can be "keep P1" only if both analyses say so; if the sensitivity
  analysis says otherwise, the owner decides (the result then depends on intervals the trace could
  not explain).

## 5. G2: main-thread tasks of 50 ms or more

- A task counts if it lasts **50.0 ms or more** and is one of: a `longtask` entry, a `handler`
  entry, a `trace` task on the stimulus renderer's main thread, or a rAF callback itself (exit
  minus entry in the frame log, since a render-callback overrun counts like any task, ADR-0003
  line 55).
- Only tasks that start between the first frame's callback and the end of the last frame count;
  the others are reported as outside the session.
- `long-animation-frame` entries are listed by type but do not count for G2: they measure frames,
  which G1 counts, and a long task inside one is also reported as a `longtask` entry (the probe on
  Electron 44.7.0 recorded under REN-12 in `.claude/paper-review/plan/breakdown_render.md`: a 60 ms
  busy task gave a 60 ms entry of each type, a 49 ms task neither).
- rAF callbacks longer than P are listed per session as render-callback overruns.
- **Timed handlers (proposed).** The app logs its own main-thread handlers (REN-12) from **3 ms**:
  half a frame, the extra delay that can make an interval late, is 8.3 ms at 60 Hz and 3.5 ms at
  144 Hz, so 3 ms catches every handler that could do so at either rate.

## 6. Valid sessions and gate requirements

A session is **not valid** for the gate, and is left out of the pooled analysis, if any frame is
flagged `hidden` or `context_lost` (the displays must stay awake), if the frame index jumps (the
frame log lost records), if any frame is flagged `post_ready_rise` (ADR-0003 1b: fix it, then
repeat the session), if `longtasks.jsonl` is missing, or if it has fewer than 2 frames. Each
session summary lists its reasons.

The pooled result states whether the **gate requirements** of ADR-0003 Decision 2 (line 52) are
met: at least 3 valid sessions of at least 30 minutes each (duration from the first to the last
rAF timestamp). The tool cannot check the other requirements, so the report lists them for the
operator: rig computer, no 1d warning (clock, display, primary display), and at least one session
with normal control-window use (the REN-21 checklist). A dry run with shorter sessions (REN-20)
gets a verdict too, marked as not meeting the requirements.

## 7. Pooling and confidence intervals (proposed, D18 a)

- **Pooled estimate.** Missed and expected frames are summed over the valid sessions; the rate is
  1,000 x missed / expected.
- **Deciding CI: block bootstrap.** Each session is cut into 60-second blocks by the rAF time of
  each interval's end frame (the last block of a session is shorter). The blocks of all valid
  sessions form one pool. A resample draws as many blocks as the pool has, with replacement, and
  computes the pooled rate; 10,000 resamples give the percentile 95% CI (2.5th and 97.5th
  percentiles, linear interpolation between order statistics, Hyndman and Fan type 7). The random
  generator is mulberry32 with the fixed seed 20261113, so that the analysis gives the same CI each
  time; the number has no other meaning.
- **Why blocks.** Missed frames come in clusters: one stall gives several, and stalls come in bursts
  (a scene change, a garbage-collection storm). Resampling single frames would treat them as
  independent and give too narrow an interval; one-minute blocks keep a cluster together.
- **Cross-check: exact Poisson interval** (Garwood) for the pooled count over the pooled expected
  frames. It assumes independent missed frames, so it is too narrow for clustered ones; it is
  reported, and the report notes when it reads the deciding CI differently, but it never changes
  the verdict. Example from the tests: 540 missed frames concentrated in 3 of 93 blocks (three
  30-minute sessions) give 1.667 per 1,000 with a bootstrap CI of 0 to 3.80 and a Poisson CI of
  1.53 to 1.81.

## 8. The verdict (ADR-0003 Decision 2, line 55)

Applied to the pooled valid sessions, once for the primary analysis and once for the sensitivity
analysis. A CI *spans* 1 per 1,000 if its lower end is below 1 and its upper end is 1 or more.

| Condition (in this order) | Verdict | Deciding |
|---|---|---|
| any G2 task | promote | G2 |
| G1 low estimate >= 1 per 1,000, and its CI does not span 1 | promote | low |
| G1 low estimate >= 1 per 1,000, and its CI spans 1 | owner decides | low |
| G1 high estimate < 1 per 1,000, and its CI does not span 1 | keep P1 | high |
| G1 high estimate < 1 per 1,000, and its CI spans 1 | owner decides | high |
| otherwise (low < 1 <= high) | owner decides | between |

The final verdict is the primary analysis's, except that "keep P1" becomes "owner decides" when the
sensitivity analysis does not also say "keep P1" (section 4). Where the owner decides, ADR-0003
asks for the decision and its reasons to be recorded from the traces.

**Single-session re-checks (D18 a).** REN-22b (the gate re-check with the v1.0-rc workload) and
REN-25 (the v1.0-rc rendering check) each run one 30-minute session, which cannot bound a rate
near 1 per 1,000. Their rule: any G2 task, or a primary G1 low estimate of 1 per 1,000 or more,
triggers D21; otherwise the check passes, with the CI reported. A session that is not valid
(section 6), for example one with a compile after ready, is not checked at all: the rule reports
"not checked" with the reasons, and the session is repeated once the cause is fixed. The tool prints
this rule's result on every run.

## 9. For the owner's approval (D18)

Approve together, or name the point to change:

1. The block bootstrap (60-second blocks, pooled across sessions, 10,000 resamples, percentile
   95% CI, fixed seed) as the deciding CI, with the exact Poisson interval as a reported
   cross-check (section 7).
2. Unattributed late intervals as a separate class, not counted by the primary analysis, with the
   sensitivity analysis and "keep P1 needs both" (section 4).
3. The single-session rule of REN-22b and REN-25 (section 8).
4. Choices ADR-0003 leaves implicit: one P per session from the rAF timestamps for both estimates
   (section 3); session validity (section 6); what counts for G2, including rAF callbacks and not
   long-animation-frame entries (section 5); the 3 ms threshold for timed handlers (section 5).

## 10. Tests

`test/frontend/gateCounting.test.ts` checks the rules on synthetic frame logs whose answers are
worked out by hand, among them ADR-0003 Validation 4's fixture:

- a steady 60 Hz session gives no missed frame;
- 100 ms stalls once a second (a model of Chromium's coalesced frames): the rAF count equals the
  net frame deficit and the entry count is larger;
- 144 Hz; a 17 ms garbage-collection-like hitch is late but not G2; a 50.0 ms task is G2 and a
  49.9 ms one is not; a 55 ms rAF callback is G2;
- lost frame-log records (a jump in the frame index) are not counted as missed frames, and the
  session is not valid;
- verdicts on three 30-minute sessions: steady (keep P1); one 50.0 ms task (promote, G2); one
  main-thread missed frame every 10 s, 537 of 324,000 (promote); the same attributed to the GPU
  process (keep P1); the same unattributed (owner decides, through the sensitivity analysis); late
  by entry times only (owner decides, between); 540 missed frames in 3 blocks (owner decides: the
  CI spans 1, while the Poisson interval would not);
- the single-session re-check rule, including a session that is not valid (not checked);
- the per-session counts and the pooled per-minute blocks give the same numbers;
- the exact Poisson intervals against textbook values; the bootstrap is reproducible;
- the command line reads session folders (times in ms or us, incomplete last lines reported) in
  Node and writes the report.

## Amendments

None yet.
