"""renderer_status reports (frame-clock checks) are kept with the session data.

The renderer reports every few seconds. The backend appends each report to a sidecar of the
experiment's data file (<data file>.renderer.jsonl), passes it to the experiment's
on_renderer_status hook (awaited if it is a coroutine), logs only changes in the warnings, and
reports a sidecar it cannot write once instead of on every report.
"""
import asyncio
import json
import logging

import pytest

OK = {"level": "info", "kinds": [], "message": "Frame clock OK: 60.00 Hz",
      "details": {"effectiveHz": 60.0}}
RATE_WARNING = {"level": "warning", "kinds": ["rate"], "message": "Frames run at 144.0 Hz",
                "details": {"vrGain": 2.4}}
REPORTS = [OK, OK, OK, RATE_WARNING, RATE_WARNING]


class HookExperiment:
    experiment_id = "hook"

    def __init__(self, data_file_path):
        self.data_file_path = str(data_file_path)
        self.seen = []

    async def on_renderer_status(self, data):
        await asyncio.sleep(0)  # suspends, so a hook that is not awaited records nothing
        self.seen.append(data)


@pytest.fixture
def send_reports(new_server, run, caplog):
    """send_reports(experiment, reports): deliver reports to a server running `experiment`."""
    caplog.set_level(logging.INFO, logger="backend.src.main")
    server = new_server()

    def send(experiment, reports):
        server.active_experiment = experiment

        async def deliver():
            for report in reports:
                assert await server._handle_renderer_status(report) is None  # no reply is sent
        run(deliver())
    return send


def messages(caplog, prefix):
    return [r for r in caplog.records if r.name == "backend.src.main" and r.getMessage().startswith(prefix)]


def test_every_report_goes_to_sidecar(send_reports, tmp_path):
    send_reports(HookExperiment(tmp_path / "hallway02-20261006.txt"), REPORTS)

    sidecar = tmp_path / "hallway02-20261006.renderer.jsonl"
    records = [json.loads(line) for line in sidecar.read_text(encoding="utf-8").splitlines()]
    assert [r["message"] for r in records] == [r["message"] for r in REPORTS]
    assert records[3]["details"]["vrGain"] == 2.4
    assert all(isinstance(r["time"], float) for r in records)


def test_async_hook_is_awaited(send_reports, tmp_path):
    experiment = HookExperiment(tmp_path / "hallway02-20261006.txt")
    send_reports(experiment, REPORTS)

    assert experiment.seen == REPORTS


def test_log_shows_only_changes(send_reports, tmp_path, caplog):
    send_reports(HookExperiment(tmp_path / "hallway02-20261006.txt"), REPORTS)

    logged = messages(caplog, "[renderer]")
    assert [r.levelno for r in logged] == [logging.INFO, logging.WARNING]
    assert "Frames run at 144.0 Hz" in logged[1].getMessage()


def test_unwritable_sidecar_reported_once(send_reports, tmp_path, caplog):
    experiment = HookExperiment(tmp_path / "missing-folder" / "x.txt")
    send_reports(experiment, [OK, OK])

    assert len(messages(caplog, "Cannot write renderer status")) == 1
    assert experiment.seen == [OK, OK]  # the hook still gets every report
