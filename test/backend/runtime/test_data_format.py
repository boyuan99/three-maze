"""docs/data-format-v1.md documents exactly the tables and logs the recorder writes
(threemaze/record/formats.py): every column with its type and whether it may be empty, every log
field and whether it is always present, and the format version."""
import re
from pathlib import Path

import pytest

from threemaze.record import formats

DOC = Path(__file__).resolve().parents[3] / "docs" / "data-format-v1.md"
RAW = "raw_<j>_counts"


def documented():
    """{file: [(name, second cell)]} from the first table under each '## N. <file>' heading."""
    tables, current, done = {}, None, set()
    for line in DOC.read_text(encoding="utf-8").splitlines():
        heading = re.match(r"^## \d+\. (\S+)$", line)
        if heading:
            current = heading.group(1)
            continue
        if current is None or current in done:
            continue
        row = re.match(r"^\| `([^`]+)` \| ([^|]+) \|", line)
        if row:
            tables.setdefault(current, []).append((row.group(1), row.group(2).strip()))
        elif current in tables and not line.startswith("|"):
            done.add(current)
    return tables


def table_cells(spec, raw_placeholder=False):
    cells, raw_seen = [], False
    for column in spec.columns:
        if raw_placeholder and column.name.startswith("raw_"):
            if not raw_seen:
                cells.append((RAW, column.kind))
                raw_seen = True
            continue
        cells.append((column.name, column.kind + (", may be empty" if column.optional else "")))
    return cells


@pytest.mark.parametrize("spec", [formats.POSES_SPEC, formats.FRAMES_SPEC, formats.TRIALS_SPEC],
                         ids=lambda spec: spec.file)
def test_every_column_is_documented(spec):
    assert documented()[spec.file] == table_cells(spec)


def test_samples_columns_are_documented():
    assert documented()[formats.SAMPLES] == table_cells(formats.samples_spec(3),
                                                        raw_placeholder=True)


@pytest.mark.parametrize("spec", formats.LOG_SPECS.values(), ids=lambda spec: spec.file)
def test_every_log_field_is_documented(spec):
    fields = documented()[spec.file]
    assert [name for name, _ in fields] == list(spec.names)
    for field, (name, present) in zip(spec.fields, fields):
        assert (present == "always") == field.required, name


def test_the_format_version_is_the_documented_one():
    status = DOC.read_text(encoding="utf-8").splitlines()[2]
    assert f"`format_version` `{formats.FORMAT_VERSION}`" in status
