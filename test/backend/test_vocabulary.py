"""The Python constants of the task vocabulary agree with schema/vocabulary.json (ADR-0005 F5).

threemaze/core/vocabulary.py is generated from the vocabulary file (`npm run vocabulary`); the
Vitest check (test/frontend/vocabulary.test.ts) fails when it is stale or the vocabulary exceeds
ADR-0002's budget. These tests read the file independently, in Python: the snake_case names, the
phase-1 and reserved lists, and the identifier pattern, which Python must match with fullmatch.
"""
import json
import re
from pathlib import Path

import pytest

from threemaze.core import vocabulary  # the repository root is on sys.path (conftest.py)

REPO = Path(__file__).resolve().parents[2]
VOCABULARY = json.loads((REPO / "schema" / "vocabulary.json").read_text(encoding="utf-8"))
ACTIONS = VOCABULARY["actions"]
CATEGORIES = VOCABULARY["eventCategories"]


def snake_case(name):
    """camelCase -> snake_case, written apart from the generator (endSession -> end_session)."""
    return re.sub(r"[A-Z]", lambda m: "_" + m.group(0).lower(), name)


def names(entries, phase=None):
    return tuple(e["name"] for e in entries if phase is None or e["phase"] == phase)


def test_actions_map_json_names_to_snake_case():
    assert vocabulary.ACTIONS == {a["name"]: snake_case(a["name"]) for a in ACTIONS}
    assert vocabulary.ACTIONS["endSession"] == "end_session"
    assert vocabulary.ACTIONS["switchWorld"] == "switch_world"
    assert all(re.fullmatch(r"[a-z][a-z0-9_]*", py) for py in vocabulary.ACTIONS.values())


def test_phase_lists_follow_the_vocabulary():
    assert vocabulary.PHASE1_ACTIONS == names(ACTIONS, 1)
    assert vocabulary.RESERVED_ACTIONS == names(ACTIONS, 2)
    assert vocabulary.EVENT_CATEGORIES == names(CATEGORIES)
    assert vocabulary.PHASE1_EVENT_CATEGORIES == names(CATEGORIES, 1)
    assert vocabulary.RESERVED_EVENT_CATEGORIES == names(CATEGORIES, 2)
    assert vocabulary.ACTION_OPERATIONS == {
        a["name"]: tuple(a["operations"]) for a in ACTIONS if "operations" in a
    }


def test_former_names_point_to_current_names():
    for former, current in vocabulary.FORMER_ACTION_NAMES.items():
        assert current in vocabulary.ACTIONS and former not in vocabulary.ACTIONS
    for former, current in vocabulary.FORMER_EVENT_NAMES.items():
        assert current in vocabulary.EVENT_CATEGORIES and former not in vocabulary.EVENT_CATEGORIES


@pytest.mark.parametrize("name", ["a", "start", "endNorth", "A1_b"])
def test_identifier_accepts(name):
    assert vocabulary.IDENTIFIER.fullmatch(name)


@pytest.mark.parametrize("name", ["", "1a", "_a", "a-b", "a.b", "@a", "a b", "é", "a\n"])
def test_identifier_rejects(name):
    assert vocabulary.IDENTIFIER.fullmatch(name) is None


def test_identifier_needs_fullmatch_in_python():
    # The anchored pattern, as JSON Schema (ECMAScript) reads it, rejects "a\n"; Python's `$` also
    # matches before a final newline, so re.match with that pattern accepts it.
    assert re.match(VOCABULARY["identifier"], "a\n")
    assert vocabulary.IDENTIFIER.fullmatch("a\n") is None
