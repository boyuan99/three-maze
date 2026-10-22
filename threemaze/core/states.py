"""Session states and the transitions between them (plan item DPR-06a).

    IDLE -> CONFIGURED -> ARMED -> RUNNING -> STOPPING -> COMPLETE
    every state that is not final -> ABORTED

IDLE        nothing loaded
CONFIGURED  the rig file is valid and loaded, the task source is known; nothing is open
ARMED       the session folder exists with the rig file in it; every bound device is open and
            checked, but no stream runs
RUNNING     the input devices stream
STOPPING    streams are being stopped, outputs put in their safe state, devices closed
COMPLETE    ended as planned
ABORTED     ended early or after a failure; the reason is recorded

Pure: no input or output, no clock of its own (the caller passes the time of each transition).
"""
from dataclasses import dataclass
from enum import Enum


class SessionState(str, Enum):
    IDLE = "idle"
    CONFIGURED = "configured"
    ARMED = "armed"
    RUNNING = "running"
    STOPPING = "stopping"
    COMPLETE = "complete"
    ABORTED = "aborted"

    @property
    def final(self) -> bool:
        return self in (SessionState.COMPLETE, SessionState.ABORTED)


S = SessionState

TRANSITIONS: dict[SessionState, frozenset[SessionState]] = {
    S.IDLE: frozenset({S.CONFIGURED, S.ABORTED}),
    S.CONFIGURED: frozenset({S.ARMED, S.ABORTED}),
    S.ARMED: frozenset({S.RUNNING, S.ABORTED}),
    S.RUNNING: frozenset({S.STOPPING, S.ABORTED}),
    S.STOPPING: frozenset({S.COMPLETE, S.ABORTED}),
    S.COMPLETE: frozenset(),
    S.ABORTED: frozenset(),
}


class InvalidTransition(Exception):
    """A transition the state diagram does not have, for example start() before arm()."""

    def __init__(self, current: SessionState, wanted: SessionState):
        super().__init__(f"cannot go from {current.value} to {wanted.value}")
        self.current = current
        self.wanted = wanted


@dataclass(frozen=True)
class Transition:
    """One state change: from, to, the session clock at the change (ns) and an optional reason."""

    source: SessionState
    target: SessionState
    t_ns: int
    reason: str | None = None


class StateMachine:
    """Holds the current state and the history of transitions."""

    def __init__(self, t_ns: int):
        self._state = S.IDLE
        self.history: list[Transition] = []
        self.created_ns = t_ns

    @property
    def state(self) -> SessionState:
        return self._state

    def can(self, target: SessionState) -> bool:
        return target in TRANSITIONS[self._state]

    def go(self, target: SessionState, t_ns: int, reason: str | None = None) -> Transition:
        if not self.can(target):
            raise InvalidTransition(self._state, target)
        step = Transition(self._state, target, t_ns, reason)
        self.history.append(step)
        self._state = target
        return step
