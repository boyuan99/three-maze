"""Watch one e2e run from outside Electron (Windows only, read-only except --kill-leftovers).
Run it with the venv's pythonw.exe, which never opens a console window. No third-party packages.

  monitor.py watch --root-pid N --out DIR [--deadline-s S] [--grace-s G] [--kill-leftovers]
                   [--ready-file FILE]
      Tracks the process tree under the Electron main process (renderer, GPU and utility processes,
      the backend's venv launcher and the real interpreter it starts). Every process is opened by
      handle as soon as it is seen, so exit codes and exit times are exact and a PID cannot be
      reused while the monitor runs. Also polls the visible top-level windows: any visible window
      owned by the tree, and any console or terminal window that was not visible when the monitor
      started, is a violation. Ends when the tree is gone, or at the deadline; with
      --kill-leftovers it then terminates (by handle) whatever is left of the tree.
      Writes DIR/monitor.json and logs to stdout. --ready-file is written once the root process is
      tracked and the console-window baseline is taken (the harness waits for it before it starts
      the backend, so that no child can come and go unseen).

  monitor.py tree PID           print the live descendants of PID (PID itself may be gone) as JSON,
                                with their creation times
  monitor.py alive PID [PID..]  print {pid: {"exe", "created"} or null} for each PID; "created" (epoch
                                seconds) tells a reused PID from the original process
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import sys
import time

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
u32 = ctypes.WinDLL("user32", use_last_error=True)
try:
    dwm = ctypes.WinDLL("dwmapi")
except OSError:
    dwm = None

TH32CS_SNAPPROCESS = 0x2
SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_TERMINATE = 0x0001
STILL_ACTIVE = 259
WAIT_OBJECT_0 = 0
INVALID_HANDLE_VALUE = wt.HANDLE(-1).value
CONSOLE_CLASSES = ("ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow")


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class FILETIME(ctypes.Structure):
    _fields_ = [("lo", wt.DWORD), ("hi", wt.DWORD)]


k32.CreateToolhelp32Snapshot.restype = wt.HANDLE
k32.CreateToolhelp32Snapshot.argtypes = [wt.DWORD, wt.DWORD]
k32.Process32FirstW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.Process32NextW.argtypes = [wt.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.OpenProcess.restype = wt.HANDLE
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.CloseHandle.argtypes = [wt.HANDLE]
k32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
k32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
k32.WaitForSingleObject.restype = wt.DWORD
k32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
k32.GetProcessTimes.argtypes = [wt.HANDLE] + [ctypes.POINTER(FILETIME)] * 4
k32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]

WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
u32.EnumWindows.argtypes = [WNDENUMPROC, wt.LPARAM]
u32.IsWindowVisible.argtypes = [wt.HWND]
u32.IsIconic.argtypes = [wt.HWND]
u32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
u32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
u32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]


def now():
    return time.time()


def ft_epoch(ft):
    v = (ft.hi << 32) | ft.lo
    return round(v / 1e7 - 11644473600, 3) if v else None


def snapshot():
    """{pid: (ppid, exe)} of every process"""
    procs = {}
    h = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not h or h == INVALID_HANDLE_VALUE:
        return procs
    try:
        e = PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = k32.Process32FirstW(h, ctypes.byref(e))
        while ok:
            procs[e.th32ProcessID] = (e.th32ParentProcessID, e.szExeFile)
            ok = k32.Process32NextW(h, ctypes.byref(e))
    finally:
        k32.CloseHandle(h)
    return procs


def open_proc(pid, terminate=False):
    access = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | (PROCESS_TERMINATE if terminate else 0)
    h = k32.OpenProcess(access, False, pid)
    if not h and terminate:
        h = k32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    return h or None


def times(h):
    c, e, kt, ut = FILETIME(), FILETIME(), FILETIME(), FILETIME()
    if not k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(ut)):
        return None, None
    return ft_epoch(c), ft_epoch(e)


def image(h):
    buf = ctypes.create_unicode_buffer(1024)
    n = wt.DWORD(1024)
    return buf.value if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)) else None


def exited(h):
    return k32.WaitForSingleObject(h, 0) == WAIT_OBJECT_0


def exit_code(h):
    code = wt.DWORD()
    if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
        return None
    return None if code.value == STILL_ACTIVE else code.value


def is_cloaked(hwnd):
    if dwm is None:
        return False
    val = ctypes.c_int(0)
    try:
        dwm.DwmGetWindowAttribute(wt.HWND(hwnd), 14, ctypes.byref(val), ctypes.sizeof(val))  # DWMWA_CLOAKED
    except Exception:
        return False
    return val.value != 0


def visible_windows():
    """[(hwnd, pid, class, title, rect, iconic)] of visible, uncloaked top-level windows"""
    found = []

    def cb(hwnd, _):
        if u32.IsWindowVisible(hwnd) and not is_cloaked(hwnd):
            pid = wt.DWORD()
            u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            cls = ctypes.create_unicode_buffer(256)
            u32.GetClassNameW(hwnd, cls, 256)
            title = ctypes.create_unicode_buffer(512)
            u32.GetWindowTextW(hwnd, title, 512)
            r = wt.RECT()
            u32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append((int(hwnd or 0), pid.value, cls.value, title.value,
                          [r.left, r.top, r.right, r.bottom], bool(u32.IsIconic(hwnd))))
        return True

    u32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def descendants(root, procs):
    out, frontier = [], [root]
    while frontier:
        p = frontier.pop()
        for pid, (ppid, exe) in procs.items():
            if ppid == p and pid not in out and pid != root:
                out.append(pid)
                frontier.append(pid)
    return out


def created_time(pid):
    h = open_proc(pid)
    if not h:
        return None
    try:
        return times(h)[0]
    finally:
        k32.CloseHandle(h)


def cmd_tree(pid):
    procs = snapshot()
    print(json.dumps([{"pid": p, "ppid": procs[p][0], "exe": procs[p][1], "created": created_time(p)}
                      for p in descendants(pid, procs)]))


def cmd_alive(pids):
    procs = snapshot()
    print(json.dumps({str(p): ({"exe": procs[p][1], "created": created_time(p)} if p in procs else None)
                      for p in pids}))


def cmd_watch(a):
    t_start = now()
    out_json = os.path.join(a.out, "monitor.json")
    with open(os.path.join(a.out, "monitor.pid"), "w") as f:
        f.write(f"{os.getpid()} {os.getppid()}")  # interpreter, venv launcher
    log = lambda s: print(f"[monitor +{now() - t_start:7.3f}s] {s}", flush=True)

    root = a.root_pid
    tracked = {}  # pid -> record (with "_h" handle)

    def track(pid, ppid, exe, parent_created):
        h = open_proc(pid, terminate=True)
        if not h:
            log(f"cannot open pid {pid} ({exe})")
            return
        created, _ = times(h)
        # guard against a reused parent PID: a child cannot be older than its parent
        if parent_created is not None and created is not None and created + 0.01 < parent_created:
            k32.CloseHandle(h)
            return
        tracked[pid] = {"pid": pid, "ppid": ppid, "exe": exe, "image": image(h), "created": created,
                        "first_seen": round(now(), 3), "exit_code": None, "exit_time": None,
                        "terminated_by_monitor": False, "_h": h}
        log(f"tracking pid {pid} ({exe}) ppid {ppid}")

    procs = snapshot()
    if root not in procs:
        log(f"root pid {root} not running")
    else:
        track(root, procs[root][0], procs[root][1], None)

    baseline_console = {w[0] for w in visible_windows() if w[2] in CONSOLE_CLASSES}
    if a.ready_file:
        with open(a.ready_file, "w") as f:
            f.write(f"{os.getpid()} tracking={sorted(tracked)}")
    window_violations = {}   # hwnd -> record (visible window owned by the tree)
    new_consoles = {}        # hwnd -> record (console/terminal window that appeared during the run)
    root_exit_time = None
    deadline = t_start + a.deadline_s
    last_snap = 0.0

    def refresh_tree():
        procs = snapshot()
        changed = True
        while changed:
            changed = False
            for pid, (ppid, exe) in procs.items():
                if pid not in tracked and ppid in tracked:
                    track(pid, ppid, exe, tracked[ppid]["created"])
                    changed = changed or pid in tracked

    def update_exits():
        for rec in tracked.values():
            if rec["exit_time"] is None and exited(rec["_h"]):
                rec["exit_code"] = exit_code(rec["_h"])
                rec["exit_time"] = times(rec["_h"])[1]
                log(f"pid {rec['pid']} ({rec['exe']}) exited code {rec['exit_code']}")

    while True:
        t = now()
        if t - last_snap >= 0.1:  # short-lived children (the lifecycle backends) must not be missed
            last_snap = t
            refresh_tree()
        update_exits()
        for hwnd, pid, cls, title, rect, iconic in visible_windows():
            rec = {"hwnd": hwnd, "pid": pid, "class": cls, "title": title, "rect": rect,
                   "iconic": iconic, "seen_at": round(t, 3)}
            if pid in tracked and hwnd not in window_violations:
                window_violations[hwnd] = rec
                log(f"VISIBLE WINDOW of tracked pid {pid}: {cls} '{title}' {rect}")
            if cls in CONSOLE_CLASSES and hwnd not in baseline_console and hwnd not in new_consoles:
                new_consoles[hwnd] = rec
                log(f"NEW CONSOLE WINDOW: {cls} pid {pid} '{title}'")
        root_rec = tracked.get(root)
        if root_rec and root_exit_time is None and root_rec["exit_time"] is not None:
            root_exit_time = now()
            deadline = min(deadline, root_exit_time + a.grace_s)
            log(f"root exited; waiting up to {a.grace_s}s for the rest of the tree")
        alive = [r for r in tracked.values() if r["exit_time"] is None]
        if (root_rec is None or root_exit_time is not None) and not alive:
            break
        if now() >= deadline:
            log(f"deadline reached with {len(alive)} tracked process(es) alive")
            break
        time.sleep(0.1)

    refresh_tree()
    update_exits()
    leftovers = [r for r in tracked.values() if r["exit_time"] is None]
    for r in leftovers:
        if a.kill_leftovers:
            ok = bool(k32.TerminateProcess(r["_h"], 1))
            r["terminated_by_monitor"] = ok
            log(f"terminated leftover pid {r['pid']} ({r['exe']}): {ok}")
    if a.kill_leftovers and leftovers:
        time.sleep(0.5)
        update_exits()

    result = {
        "root_pid": root,
        "monitor_pid": os.getpid(),
        "monitor_launcher_pid": os.getppid(),
        "started": round(t_start, 3),
        "ended": round(now(), 3),
        "root_exit_seen": round(root_exit_time, 3) if root_exit_time else None,
        "processes": [{k: v for k, v in r.items() if k != "_h"} for r in tracked.values()],
        "leftovers_at_end": [{"pid": r["pid"], "exe": r["exe"]} for r in leftovers],
        "still_alive_after_kill": [r["pid"] for r in tracked.values() if r["exit_time"] is None],
        "visible_windows_of_tree": list(window_violations.values()),
        "new_console_windows": list(new_consoles.values()),
        "baseline_console_windows": len(baseline_console),
    }
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    for r in tracked.values():
        k32.CloseHandle(r["_h"])
    log(f"done: {len(tracked)} processes tracked, {len(leftovers)} leftover, "
        f"{len(window_violations)} visible window(s), {len(new_consoles)} new console window(s)")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("watch")
    w.add_argument("--root-pid", type=int, required=True)
    w.add_argument("--out", required=True)
    w.add_argument("--deadline-s", type=float, default=300)
    w.add_argument("--grace-s", type=float, default=15)
    w.add_argument("--kill-leftovers", action="store_true")
    w.add_argument("--ready-file")
    t = sub.add_parser("tree")
    t.add_argument("pid", type=int)
    al = sub.add_parser("alive")
    al.add_argument("pids", type=int, nargs="+")
    a = p.parse_args()
    if a.cmd == "watch":
        cmd_watch(a)
    elif a.cmd == "tree":
        cmd_tree(a.pid)
    else:
        cmd_alive(a.pids)


if __name__ == "__main__":
    main()
