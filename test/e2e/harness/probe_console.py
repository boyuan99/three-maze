"""Child probe: report this process's console and any visible console/terminal windows."""
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

k = ctypes.windll.kernel32
u = ctypes.windll.user32
k.GetConsoleWindow.restype = wt.HWND
h = k.GetConsoleWindow()
pids = (wt.DWORD * 16)()
n = k.GetConsoleProcessList(pids, 16)
print(f"pid={os.getpid()} ppid={os.getppid()} console_hwnd={h} "
      f"console_visible={bool(h and u.IsWindowVisible(h))} console_procs={n}", flush=True)

PROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
CLASSES = ("ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow")


def visible_console_windows():
    found = []

    def cb(hwnd, _):
        if u.IsWindowVisible(hwnd):
            cls = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, cls, 256)
            if cls.value in CLASSES:
                title = ctypes.create_unicode_buffer(512)
                u.GetWindowTextW(hwnd, title, 512)
                pid = wt.DWORD()
                u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                found.append((cls.value, pid.value, title.value))
        return True

    u.EnumWindows(PROC(cb), 0)
    return found


time.sleep(0.5)  # give a newly created console window time to appear
for w in visible_console_windows():
    print("visible console window:", w, flush=True)
print("probe done", flush=True)
if len(sys.argv) > 1:
    time.sleep(float(sys.argv[1]))
