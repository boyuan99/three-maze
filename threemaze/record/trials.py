"""trials.tsv: one row per trial, built from the task's trial events and the reward requests and
their outcomes (ADR-0002, Rig runtime: "the trial results table built from events plus acks").

Inputs, as the recorder logs them (docs/data-format-v1.md, sections 5 to 7):

- events.jsonl records of kind trial_start and trial_end, with the stamp (seq, epoch, t_dev_us)
  and data.trial, the task's trial index; trial_end also has data.outcome;
- commands.jsonl records: a request with action reward, its cmd_id and width_us (the commanded
  pulse width); an outcome with the same cmd_id: done, truncated, refused, failed or unresolved,
  and width_us when the device or the runtime reported one.

A reward belongs to the trial its request names (field trial); without one, to the trial that is
open, or, between two trials, to the trial that ended last. So a reward requested in the sample
that ends a trial counts for that trial whichever of the two actions the task dispatched first.
A request before the first trial belongs to none; it stays in commands.jsonl only.

A trial's row is written once the trial has ended, the next trial has started and every reward of
the trial has an outcome; when the session ends, every remaining trial is written, an open trial
with ended = 0 and a reward without an outcome as unresolved. The first outcome of a request
counts; a later one (an acknowledgement after an unresolved outcome, device protocol v1 rule H8)
stays in commands.jsonl and changes nothing.

The table matches an outcome to a request recorded before it, so whoever sends a request records
it first (plan item DPR-09): an outcome whose request was not recorded yet stays in commands.jsonl
only, and the request then counts as unresolved.
"""
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .formats import OUTCOMES, TRIALS_SPEC

MAX_WARNINGS = 20


@dataclass
class _Reward:
    trial: int | None
    width_us: int
    outcome: str | None = None
    delivered_us: int | None = None


@dataclass
class _Trial:
    index: int
    start: tuple[int, int, int, int]               # seq, epoch, t_dev_us, t_host_ns
    end: tuple[int, int, int, int] | None = None
    outcome: str | None = None
    rewards: list[int] = field(default_factory=list)  # cmd_ids
    superseded: bool = False                          # a later trial has started


class TrialTable:
    def __init__(self, emit: Callable[[str], None]):
        self._emit = emit
        self._trials: dict[int, _Trial] = {}     # trials whose row is not written yet
        self._written: set[int] = set()
        self._open: int | None = None            # the trial started last, while it is open
        self._last_ended: int | None = None      # the trial that ended last, until the next starts
        self._rewards: dict[int, _Reward] = {}   # cmd_id -> reward request
        self.rows = 0
        self.rewards_outside_trials = 0
        self.warnings: list[str] = []
        self.warning_count = 0

    def _warn(self, message: str) -> None:
        self.warning_count += 1
        if len(self.warnings) < MAX_WARNINGS:
            self.warnings.append(message)

    @staticmethod
    def _stamp(record: Mapping[str, Any]) -> tuple[int, int, int, int]:
        return record["seq"], record["epoch"], record["t_dev_us"], record["t_host_ns"]

    # --- inputs ----------------------------------------------------------------------------------

    def event(self, record: Mapping[str, Any]) -> None:
        kind = record["kind"]
        if kind not in ("trial_start", "trial_end"):
            return
        data = record["data"]
        index = data["trial"]
        if kind == "trial_start":
            if index in self._trials or index in self._written:
                self._warn(f"trial {index} started again at seq {record['seq']}; ignored")
                return
            if self._open is not None:
                self._warn(f"trial {index} started while trial {self._open} was open")
            for trial in self._trials.values():
                trial.superseded = True
            self._trials[index] = _Trial(index, self._stamp(record))
            self._open, self._last_ended = index, None
        else:
            trial = self._trials.get(index)
            if trial is None or trial.end is not None:
                self._warn(f"trial_end of trial {index} at seq {record['seq']}, which is not open;"
                           " ignored")
                return
            trial.end, trial.outcome = self._stamp(record), data["outcome"]
            if self._open == index:
                self._open = None
            self._last_ended = index
        self._write_ready()

    def command(self, record: Mapping[str, Any]) -> None:
        kind, cmd_id = record["kind"], record["cmd_id"]
        if kind == "request" and record.get("action") == "reward":
            if cmd_id in self._rewards:
                self._warn(f"reward request cmd_id {cmd_id} seen twice; the second is ignored")
                return
            index = self._owner(record.get("trial"))
            self._rewards[cmd_id] = _Reward(index, record["width_us"])
            if index is None:
                self.rewards_outside_trials += 1
            else:
                self._trials[index].rewards.append(cmd_id)
        elif kind == "outcome":
            reward = self._rewards.get(cmd_id)
            if reward is None or reward.outcome is not None:
                return  # not a reward request, or a late outcome: commands.jsonl keeps it
            reward.outcome = record["outcome"]
            if reward.outcome in ("done", "truncated"):
                reward.delivered_us = record.get("width_us")
            self._write_ready()

    def _owner(self, named: int | None) -> int | None:
        if named is not None:
            if named in self._trials:
                return named
            self._warn(f"a reward names trial {named}, which is not started or already written;"
                       " counted outside trials")
            return None
        if self._open is not None:
            return self._open
        return self._last_ended

    # --- rows ------------------------------------------------------------------------------------

    def _write_ready(self) -> None:
        for index in [i for i, t in self._trials.items() if t.end is not None and t.superseded]:
            trial = self._trials[index]
            if all(self._rewards[c].outcome is not None for c in trial.rewards):
                self._write(trial)

    def close(self) -> None:
        """The session ends: write every trial that is left, in the order they started."""
        for trial in list(self._trials.values()):
            self._write(trial)

    def _write(self, trial: _Trial) -> None:
        rewards = [self._rewards[c] for c in trial.rewards]
        counts = {outcome: 0 for outcome in OUTCOMES}
        for reward in rewards:
            counts[reward.outcome or "unresolved"] += 1
        end = trial.end or (None, None, None, None)
        values = (trial.index, *trial.start, *end, trial.outcome, trial.end is not None,
                  len(rewards), sum(r.width_us for r in rewards),
                  counts["done"], counts["truncated"], counts["refused"], counts["failed"],
                  counts["unresolved"], sum(r.delivered_us or 0 for r in rewards))
        line = TRIALS_SPEC.row(values)
        del self._trials[trial.index]
        self._written.add(trial.index)
        if self._open == trial.index:
            self._open = None
        if self._last_ended == trial.index:
            self._last_ended = None
        self.rows += 1
        self._emit(line)
