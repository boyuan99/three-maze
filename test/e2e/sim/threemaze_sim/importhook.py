"""Patch modules right after they are first imported.

The sim must not import pyserial or nidaqmx itself: nidaqmx pulls in numpy, and importing it at
startup would change when the backend loads those DLLs (the step-0 backend had a hang that depended
on exactly that). So a finder at the front of sys.meta_path wraps the real loader of the named
modules and runs the patch as soon as the module's own code has executed.
"""
import sys


class _PatchingLoader:
    def __init__(self, loader, patch):
        self._loader = loader
        self._patch = patch

    def create_module(self, spec):
        create = getattr(self._loader, "create_module", None)
        return create(spec) if create is not None else None

    def exec_module(self, module):
        self._loader.exec_module(module)
        self._patch(module)

    def __getattr__(self, name):  # get_source, get_resource_reader, is_package, ...
        return getattr(self._loader, name)


class PostImportPatcher:
    def __init__(self, patches):
        self._patches = dict(patches)
        self._finding = set()

    def find_spec(self, fullname, path=None, target=None):
        patch = self._patches.get(fullname)
        if patch is None or fullname in self._finding:
            return None
        self._finding.add(fullname)
        try:
            spec = None
            for finder in sys.meta_path:
                if finder is self:
                    continue
                find_spec = getattr(finder, "find_spec", None)
                if find_spec is None:
                    continue
                spec = find_spec(fullname, path, target)
                if spec is not None:
                    break
        finally:
            self._finding.discard(fullname)
        if spec is None:
            return None
        if spec.loader is None or not hasattr(spec.loader, "exec_module"):
            raise ImportError(f"threemaze_sim cannot patch {fullname}: unsupported loader {spec.loader!r}")
        spec.loader = _PatchingLoader(spec.loader, patch)
        return spec

    def invalidate_caches(self):
        pass


def install(patches):
    """patches: {module name: callable(module)}. Already imported modules are patched at once."""
    sys.meta_path.insert(0, PostImportPatcher(patches))
    for name, patch in patches.items():
        module = sys.modules.get(name)
        if module is not None:
            patch(module)
