"""Reading a session folder's tables and logs (docs/data-format-v1.md, section 11).

    from threemaze.record.read import read_log, read_table
    samples = read_table("ses-.../samples.tsv")      # .columns, .rows (dicts of typed values)
    events = read_log("ses-.../events.jsonl")        # .records

The writer flushes about once a second, so a crash can leave a file whose last line has no line
end: the reader drops that line and sets `partial`. Any other damaged line is an error
(DataFileError, with the line number), and so is a table without its header row, which the
recorder writes before anything else. Values come back as they were written: integers as int,
floats as the same double, booleans as bool, empty cells as None.
"""
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .formats import LOG_SPECS, SAMPLES, TABLE_SPECS, table_spec
from .tables import TableSpec, parse_cell


class DataFileError(ValueError):
    """A table or log that cannot be read: what, and the line."""


@dataclass
class Table:
    path: Path
    columns: list[str]
    rows: list[dict[str, Any]]
    partial: bool       # a last line without its line end was dropped


@dataclass
class Log:
    path: Path
    records: list[dict[str, Any]]
    partial: bool


def _lines(path: Path) -> tuple[list[tuple[int, str]], bool]:
    """The complete lines (number, text without the line end) and whether a last line without its
    line end was dropped."""
    data = Path(path).read_bytes()
    parts = data.split(b"\n")
    partial = parts.pop() != b""  # the bytes after the last LF
    lines = []
    for number, raw in enumerate(parts, 1):
        if raw.endswith(b"\r"):
            raw = raw[:-1]
        try:
            lines.append((number, raw.decode("utf-8")))
        except UnicodeDecodeError as exc:
            raise DataFileError(f"{path}:{number}: not UTF-8 ({exc})") from None
    return lines, partial


def read_table(path: str | Path, spec: TableSpec | None = None) -> Table:
    """A table of the session folder. Its spec comes from its file name (samples.tsv, pose.tsv,
    frames.tsv, trials.tsv) unless given; a table of another name is read as text."""
    path = Path(path)
    lines, partial = _lines(path)
    if not lines:
        raise DataFileError(f"{path}: no header row")
    header_number, header_text = lines[0]
    columns = header_text.split("\t")
    if spec is None and (path.name == SAMPLES or path.name in TABLE_SPECS):
        try:
            spec = table_spec(path.name, columns)
        except ValueError as exc:
            raise DataFileError(f"{path}:{header_number}: {exc}") from None
    if spec is not None and tuple(columns) != spec.names:
        raise DataFileError(f"{path}:{header_number}: the header is not that of {spec.file} in"
                            f" this data format version: {columns}")
    rows = []
    for number, text in lines[1:]:
        cells = text.split("\t")
        if len(cells) != len(columns):
            raise DataFileError(f"{path}:{number}: {len(cells)} cells for {len(columns)} columns")
        if spec is None:
            rows.append(dict(zip(columns, cells)))
            continue
        try:
            rows.append({column.name: parse_cell(column, cell)
                         for column, cell in zip(spec.columns, cells)})
        except ValueError as exc:
            raise DataFileError(f"{path}:{number}: {exc}") from None
    return Table(path, columns, rows, partial)


def _no_constant(name: str) -> Any:
    raise ValueError(f"{name} is not a JSON number")


def read_log(path: str | Path) -> Log:
    """A log of the session folder: one JSON object per line."""
    path = Path(path)
    lines, partial = _lines(path)
    records = []
    known = LOG_SPECS.get(path.name)
    for number, text in lines:
        try:
            record = json.loads(text, parse_constant=_no_constant)
        except ValueError as exc:
            raise DataFileError(f"{path}:{number}: not JSON ({exc})") from None
        if not isinstance(record, dict):
            raise DataFileError(f"{path}:{number}: not a JSON object")
        if known is not None:
            missing = [f.name for f in known.fields if f.required and f.name not in record]
            if missing:
                raise DataFileError(f"{path}:{number}: no {', '.join(missing)}")
        records.append(record)
    return Log(path, records, partial)
