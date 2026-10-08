"""Redirect the rig's data folder D:\\VirmenData to $THREEMAZE_SIM_DIR/VirmenData.

Any path under D:\\VirmenData (either slash style, any case, also D:VirmenData and \\\\?\\D:\\...)
given to builtins.open / io.open, os.makedirs, os.mkdir, os.listdir, os.scandir, os.stat,
os.remove, os.unlink, os.rmdir, os.rename, os.replace or os.path.exists / isdir / isfile /
getsize / getmtime is rewritten to the same relative path under the sim folder. Other paths, and
other folders on D:, are passed through untouched.

THREEMAZE_SIM_DATA=missing instead makes every such call fail the way it does on a machine
without a D: drive (FileNotFoundError, [WinError 3] for directories), without touching a real D:.
"""
import builtins
import io
import ntpath
import os
import re

_VIRMEN = re.compile(r"^(?:\\\\\?\\)?d:\\?virmendata(?:\\(?P<rest>.*))?$", re.IGNORECASE)
_MISSING = object()

_settings = None
_log = None
_seen = set()
real = {}  # name -> original function, for code that needs to bypass the redirect


def translate(path):
    """Return the redirected path (str) for a path under D:\\VirmenData, else the path unchanged."""
    routed = _route(path, None)
    return path if routed is _MISSING else routed


def _route(path, fn_name):
    if isinstance(path, str):
        text = path
    elif isinstance(path, os.PathLike):
        text = os.fspath(path)
        if not isinstance(text, str):
            return path
    else:
        return path  # file descriptors, bytes paths
    norm = ntpath.normpath(text)
    match = _VIRMEN.match(norm)
    if not match:
        return path
    if _settings.data_mode == "missing":
        _note("redirect_missing", fn_name, text, None)
        return _MISSING
    rest = match.group("rest")
    target = os.path.join(_settings.virmen_dir, rest) if rest else _settings.virmen_dir
    _note("redirect", fn_name, text, target)
    return target


def _note(event, fn_name, src, dst):
    key = (event, fn_name, src)
    if fn_name is None or key in _seen or _log is None:
        return
    _seen.add(key)
    _log.write(event, fn=fn_name, src=src, dst=dst)


def _path_not_found(path):
    import ctypes
    message = ctypes.FormatError(3).rstrip(" .\r\n")  # localized "The system cannot find the path specified"
    return OSError(0, message, path, 3)  # -> FileNotFoundError, [WinError 3]


def _missing_open(path):
    raise OSError(2, os.strerror(2), path)  # FileNotFoundError: [Errno 2] No such file or directory


def _missing_makedirs(path):
    drive = ntpath.splitdrive(ntpath.normpath(os.fspath(path)))[0]
    raise _path_not_found(drive + "\\")  # os.makedirs fails at the missing drive root


def _missing_raise(path):
    raise _path_not_found(path)


def _missing_false(path):
    return False


def _wrap(name, original, arg_name, on_missing):
    def wrapper(*args, **kwargs):
        if args:
            routed = _route(args[0], name)
            if routed is _MISSING:
                return on_missing(args[0])
            args = (routed,) + args[1:]
        elif arg_name in kwargs:
            routed = _route(kwargs[arg_name], name)
            if routed is _MISSING:
                return on_missing(kwargs[arg_name])
            kwargs[arg_name] = routed
        return original(*args, **kwargs)

    wrapper.__name__ = getattr(original, "__name__", name)
    wrapper.__qualname__ = wrapper.__name__
    wrapper.__doc__ = getattr(original, "__doc__", None)
    wrapper.__wrapped__ = original
    return wrapper


def _wrap2(name, original):
    def wrapper(src, dst, *args, **kwargs):
        new_src, new_dst = _route(src, name), _route(dst, name)
        if new_src is _MISSING:
            _missing_raise(src)
        if new_dst is _MISSING:
            _missing_raise(dst)
        return original(new_src, new_dst, *args, **kwargs)

    wrapper.__name__ = getattr(original, "__name__", name)
    wrapper.__qualname__ = wrapper.__name__
    wrapper.__doc__ = getattr(original, "__doc__", None)
    wrapper.__wrapped__ = original
    return wrapper


def install(settings, log):
    global _settings, _log
    _settings, _log = settings, log
    if settings.data_mode == "ok":
        os.makedirs(settings.virmen_dir, exist_ok=True)  # the folder exists on the rig

    one_path = [
        # (owner, attribute, name of the path argument, behaviour when the drive is "missing")
        (builtins, "open", "file", _missing_open),
        (io, "open", "file", _missing_open),
        (os, "makedirs", "name", _missing_makedirs),
        (os, "mkdir", "path", _missing_raise),
        (os, "listdir", "path", _missing_raise),
        (os, "scandir", "path", _missing_raise),
        (os, "stat", "path", _missing_raise),
        (os, "remove", "path", _missing_raise),
        (os, "unlink", "path", _missing_raise),
        (os, "rmdir", "path", _missing_raise),
        (os.path, "exists", "path", _missing_false),
        (os.path, "isdir", "s", _missing_false),
        (os.path, "isfile", "path", _missing_false),
        (os.path, "getsize", "filename", _missing_raise),
        (os.path, "getmtime", "filename", _missing_raise),
    ]
    for owner, attr, arg_name, on_missing in one_path:
        original = getattr(owner, attr)
        key = f"{owner.__name__}.{attr}"
        real[key] = original
        setattr(owner, attr, _wrap(key, original, arg_name, on_missing))
    for attr in ("rename", "replace"):
        original = getattr(os, attr)
        real[f"os.{attr}"] = original
        setattr(os, attr, _wrap2(f"os.{attr}", original))
