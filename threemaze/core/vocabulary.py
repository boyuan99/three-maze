"""Names of the declarative task vocabulary (ADR-0005 F5).

Generated from schema/vocabulary.json by `npm run vocabulary` (tools/vocabulary/generate.ts).
Do not edit: change the vocabulary file and regenerate. ADR-0002 keeps the format within 12
actions and 6 event categories; phase 2 extends the same format, so its reserved names count too.
JSON uses the camelCase action names and Python the snake_case ones (ACTIONS maps one to the
other); event categories and operations are the same in both.
"""
import re

#: Every name an author chooses (ADR-0005 F4). Match it with IDENTIFIER.fullmatch(name): in Python
#: `$` also matches before a final newline, in ECMAScript (JSON Schema patterns) it does not.
IDENTIFIER = re.compile("[A-Za-z][A-Za-z0-9_]*")

#: Every declarative action, phase 2 included: JSON name -> Python name
ACTIONS = {
    "reward": "reward",
    "teleport": "teleport",
    "freeze": "freeze",
    "display": "display",
    "timer": "timer",
    "trial": "trial",
    "set": "set",
    "endSession": "end_session",
    "setGain": "set_gain",
    "setCue": "set_cue",
    "emit": "emit",
    "switchWorld": "switch_world",
}

#: Actions an experiment file of format 1.0 may use (JSON names)
PHASE1_ACTIONS = ("reward", "teleport", "freeze", "display", "timer", "trial", "set", "endSession")

#: Actions reserved for later versions (JSON names)
RESERVED_ACTIONS = ("setGain", "setCue", "emit", "switchWorld")

#: Operations of the merged actions
ACTION_OPERATIONS = {
    "display": ("blank", "on"),
    "timer": ("start", "cancel"),
    "trial": ("start", "end"),
}

#: Task-event categories, phase 2 included; an event is "<category>:<name>"
EVENT_CATEGORIES = ("enter", "exit", "timer", "input", "message", "world")

#: Task-event categories of format 1.0
PHASE1_EVENT_CATEGORIES = ("enter", "exit", "timer")

#: Task-event categories reserved for later versions
RESERVED_EVENT_CATEGORIES = ("input", "message", "world")

#: Earlier action names (v0.3, designs, prototypes) -> the action that replaces each
FORMER_ACTION_NAMES = {
    "water": "reward",
    "deliverWater": "reward",
    "lock_motion": "freeze",
    "blackout": "display",
    "startTimer": "timer",
    "cancelTimer": "timer",
    "set_timer": "timer",
    "cancel_timer": "timer",
    "startTrial": "trial",
    "endTrial": "trial",
    "start_trial": "trial",
    "end_trial": "trial",
}

#: Earlier event names -> the category that replaces each
FORMER_EVENT_NAMES = {
    "zone_enter": "enter",
    "zone_exit": "exit",
}
