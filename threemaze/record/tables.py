"""How a value is written into the session folder's tables and logs (docs/data-format-v1.md,
section 2).

A table (.tsv) is UTF-8 text: one header row of column names, then one row per record, cells
separated by one TAB, every row ended by LF. A log (.jsonl) has one JSON object per line, ended by
LF. Values are written so that reading them back gives exactly what was written:

    int     decimal digits, with '-' when negative
    float   the shortest decimal that reads back as the same double (Python's repr; JavaScript's
            JSON.stringify picks the same digits, though it writes 1e16 as 10000000000000000 where
            Python writes 1e+16), so 0.1 is written 0.1 and -0.0 stays -0.0
    number  an int or a float, each written as above (counts that a device may send as decimals)
    bool    1 or 0
    token   an id or a name: letters, digits and _ . : + - only, so it never holds a TAB or a line
            end
    empty   a value that is absent, in a column whose description says it may be

NaN and infinity are refused, as the link protocol refuses them (protocol/v1/SPEC.md, E2). A value
of the wrong type is refused too, with a RecordError naming the column: the recorder checks every
value on the caller's thread, so its writer thread only ever writes valid lines.

Numbers are written with float.__repr__ and int.__repr__, as json writes them, not with the value's
own repr: a subclass may print otherwise, and numpy 2 (pinned in requirements.txt) prints a
numpy.float64 as np.float64(0.1), which no reader takes for a number.

Text patterns must match the whole value (fullmatch): Python's $ also matches before a final line
end, so "hallway\\n" would pass ^...$ and split its row in two.
"""
import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

KINDS = ("int", "float", "number", "bool", "token")
MAX_EXACT_INT = 2 ** 53  # an int a float column holds exactly
_TOKEN = re.compile(r"[A-Za-z0-9_.:+-]{1,128}")
_INT_TEXT = re.compile(r"-?(0|[1-9][0-9]*)")


class RecordError(ValueError):
    """A value that cannot be recorded: wrong type, not finite, or missing."""


@dataclass(frozen=True)
class Column:
    name: str
    kind: str                 # one of KINDS
    unit: str | None          # the unit, also the last part of the name (t_dev_us: "us")
    doc: str                  # what it holds, for docs/data-format-v1.md
    optional: bool = False    # may be empty

    def __post_init__(self):
        if self.kind not in KINDS:
            raise ValueError(f"column {self.name}: unknown kind {self.kind!r}")


@dataclass(frozen=True)
class TableSpec:
    """One table: its file name and its columns, in order."""

    file: str
    columns: tuple[Column, ...]
    doc: str

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(column.name for column in self.columns)

    def header(self) -> str:
        return "\t".join(self.names) + "\n"

    def row(self, values: Sequence[Any]) -> str:
        """One row as a line, from one value per column (None for an empty cell)."""
        if len(values) != len(self.columns):
            raise RecordError(f"{self.file}: {len(values)} values for {len(self.columns)} columns")
        return "\t".join(cell(column, value) for column, value in zip(self.columns, values)) + "\n"


def _finite(column: Column, value: float) -> float:
    if not math.isfinite(value):
        raise RecordError(f"{column.name}: {value!r} is not a finite number")
    return value


def cell(column: Column, value: Any) -> str:
    """The text of one cell."""
    if value is None:
        if column.optional:
            return ""
        raise RecordError(f"{column.name}: missing (this column is never empty)")
    kind = column.kind
    if kind == "bool":
        if isinstance(value, bool):
            return "1" if value else "0"
    elif isinstance(value, bool):
        pass  # a bool is not a number here
    elif kind == "int":
        if isinstance(value, int):
            return int.__repr__(value)
    elif kind == "float":
        if isinstance(value, float):
            return float.__repr__(_finite(column, value))
        if isinstance(value, int):
            # JSON from JavaScript writes 0.0 as 0, so whole numbers arrive as ints
            if abs(value) > MAX_EXACT_INT:
                raise RecordError(f"{column.name}: {value} does not fit a double exactly")
            return float.__repr__(float(value))
    elif kind == "number":
        if isinstance(value, int):
            return int.__repr__(value)
        if isinstance(value, float):
            return float.__repr__(_finite(column, value))
    elif kind == "token":
        if isinstance(value, str) and _TOKEN.fullmatch(value):
            return value
        if isinstance(value, str):
            raise RecordError(f"{column.name}: {value!r} is not an id (letters, digits, _ . : + -)")
    raise RecordError(f"{column.name}: {type(value).__name__} {value!r} is not a {kind}")


def parse_cell(column: Column, text: str) -> Any:
    """The value a cell holds (the inverse of cell); ValueError if it is not one."""
    if text == "":
        if column.optional:
            return None
        raise ValueError(f"{column.name}: empty")
    kind = column.kind
    if kind == "int":
        if not _INT_TEXT.fullmatch(text):
            raise ValueError(f"{column.name}: {text!r} is not an integer")
        return int(text)
    if kind == "float":
        value = float(text)
        if not math.isfinite(value):
            raise ValueError(f"{column.name}: {text!r} is not a finite number")
        return value
    if kind == "number":
        if _INT_TEXT.fullmatch(text):
            return int(text)
        return parse_cell(Column(column.name, "float", None, ""), text)
    if kind == "bool":
        if text not in ("0", "1"):
            raise ValueError(f"{column.name}: {text!r} is not 0 or 1")
        return text == "1"
    if not _TOKEN.fullmatch(text):
        raise ValueError(f"{column.name}: {text!r} is not an id")
    return text


def _json_value(value: Any) -> Any:
    if isinstance(value, Mapping):  # read-only mappings, such as a rig file's
        return dict(value)
    raise TypeError(f"{type(value).__name__} is not a JSON value")


def json_line(record: Mapping[str, Any]) -> str:
    """One log line: compact JSON, ASCII only, floats in shortest round-trip form, NaN refused."""
    try:
        return json.dumps(record, separators=(",", ":"), allow_nan=False,
                          default=_json_value) + "\n"
    except (TypeError, ValueError) as exc:
        raise RecordError(f"not recordable as JSON: {exc}") from None
