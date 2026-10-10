"""Driver registry: driver name -> class. Built-in drivers register when threemaze.devices is
imported; the rig file schema lists the built-in names (rigs/schema/rig-v1.schema.json)."""
from collections.abc import Callable

from .devices import Device

_drivers: dict[str, type[Device]] = {}


def register(name: str) -> Callable[[type[Device]], type[Device]]:
    """Class decorator: make a Device subclass available to rig files as `driver: name`."""

    def add(cls: type[Device]) -> type[Device]:
        if not (isinstance(cls, type) and issubclass(cls, Device)):
            raise TypeError(f"{cls!r} is not a Device subclass")
        known = _drivers.get(name)
        if known is not None and known is not cls:
            owner = f"{known.__module__}.{known.__qualname__}"
            raise ValueError(f"driver {name!r} is already registered by {owner}")
        cls.driver = name
        _drivers[name] = cls
        return cls

    return add


def driver_class(name: str) -> type[Device] | None:
    return _drivers.get(name)


def driver_names() -> list[str]:
    return sorted(_drivers)
