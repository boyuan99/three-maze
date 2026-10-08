"""Self-test of the simulated rig without the backend: runs each case of selftest_case.py in its own
python.exe / pythonw.exe process with the sim's environment and prints a summary.

Usage: python selftest_sim.py --out <dir> [--report-timing]
Run by test/e2e/run.mjs (scenario "sim"). Exit code 0 when every case passed, 1 otherwise.
--report-timing (run.mjs --ci): measure the tight timing tolerances and report them, without asserting
them (see selftest_case.py).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
E2E = os.path.dirname(HERE)
SIM = os.path.join(E2E, "sim")
REPO = os.path.normpath(os.path.join(E2E, "..", ".."))
VENV = os.path.join(REPO, ".venv", "Scripts")
CREATE_NO_WINDOW = 0x08000000


def child_env(sim_dir, active=True, **extra):
    env = {k: v for k, v in os.environ.items() if not k.startswith("THREEMAZE_") and k != "ELECTRON_RUN_AS_NODE"}
    env["PYTHONPATH"] = SIM
    env["PYTHONIOENCODING"] = "utf-8"
    if active:
        env["THREEMAZE_SIM"] = "1"
        env["THREEMAZE_SIM_DIR"] = sim_dir
    env.update(extra)
    return env


REPORT_TIMING = False


def run_case(out_dir, name, case, exe="python.exe", active=True, **extra):
    sim_dir = os.path.join(out_dir, name)
    shutil.rmtree(sim_dir, ignore_errors=True)
    os.makedirs(sim_dir)
    result_path = os.path.join(sim_dir, "result.json")
    argv = [os.path.join(VENV, exe), os.path.join(HERE, "selftest_case.py"), case, result_path]
    if REPORT_TIMING:
        argv.append("--report-timing")
    proc = subprocess.run(argv,
                          cwd=sim_dir, env=child_env(sim_dir, active, **extra), capture_output=True, text=True,
                          timeout=60, creationflags=CREATE_NO_WINDOW)
    if os.path.exists(result_path):
        with open(result_path, encoding="utf-8") as fh:
            result = json.load(fh)
    else:
        result = {"case": case, "ok": False, "checks": [["result written", False, proc.stderr[-2000:]]]}
    result.update(name=name, exe=exe, returncode=proc.returncode, stderr_tail=proc.stderr[-500:])
    return result


def run_fail_closed(out_dir):
    sim_dir = os.path.join(out_dir, "fail-closed")
    shutil.rmtree(sim_dir, ignore_errors=True)
    os.makedirs(sim_dir)
    proc = subprocess.run([os.path.join(VENV, "python.exe"), "-c", "print('ran')"], cwd=sim_dir,
                          env=child_env(sim_dir, THREEMAZE_SIM_SPEED="fast"), capture_output=True, text=True,
                          timeout=60, creationflags=CREATE_NO_WINDOW)
    log_path = os.path.join(sim_dir, "sim_error.log")
    logged = os.path.exists(log_path) and "THREEMAZE_SIM_SPEED='fast'" in open(log_path, encoding="utf-8").read()
    checks = [["exit code 86", proc.returncode == 86, proc.returncode],
              ["program did not run", "ran" not in proc.stdout, proc.stdout],
              ["sim_error.log explains", logged, log_path]]
    return {"name": "fail-closed", "case": "fail-closed", "exe": "python.exe", "returncode": proc.returncode,
            "ok": all(ok for _, ok, _ in checks), "checks": checks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="output folder (not on D:, which the sim redirects)")
    parser.add_argument("--report-timing", action="store_true",
                        help="report the timing tolerances instead of asserting them (shared CI runners)")
    args = parser.parse_args()
    global REPORT_TIMING
    REPORT_TIMING = args.report_timing
    os.makedirs(args.out, exist_ok=True)
    results = [
        run_case(args.out, "main-python", "main"),
        run_case(args.out, "main-pythonw", "main", exe="pythonw.exe"),
        run_case(args.out, "inactive", "inactive", active=False),
        run_case(args.out, "serial-missing", "serial_missing", THREEMAZE_SIM_SERIAL="missing"),
        run_case(args.out, "serial-silent", "serial_silent", THREEMAZE_SIM_SERIAL="silent"),
        run_case(args.out, "daq-missing", "daq_missing", THREEMAZE_SIM_DAQ="missing"),
        run_case(args.out, "data-missing", "data_missing", THREEMAZE_SIM_DATA="missing"),
        run_case(args.out, "speed-1.3", "speed", THREEMAZE_SIM_SPEED="1.3"),
        run_case(args.out, "cross-process-busy", "cross_process_busy"),
        run_fail_closed(args.out),
    ]
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=1)
    for result in results:
        print(f"{'PASS' if result['ok'] else 'FAIL'}  {result['name']:<16} ({result['exe']}, rc={result['returncode']})")
        for name, ok, detail in result["checks"]:
            if not ok:
                print(f"      FAILED {name}: {detail}")
        for t in result.get("timing", []):
            if not t["within"] and not t["asserted"]:
                print(f"      timing outside {t['low']}..{t['high']} (reported, not asserted): {t['name']}: {t['value']}")
    sys.exit(0 if all(result["ok"] for result in results) else 1)


if __name__ == "__main__":
    main()
