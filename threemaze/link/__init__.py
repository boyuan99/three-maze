"""three-maze/link: the protocol between the rig runtime, the motion worker and monitors
(protocol/v1/SPEC.md).

    validate.py  the protocol's validator (plan item DPR-05a), twin of src/protocol/validate.js
    server.py    the runtime's WebSocket server: handshake, heartbeats, session state, the sample
                 stream to the motion worker, poses and events received and logged (DPR-06b)
    stream.py    the ordered, lossless sample queue with its session alarm (DPR-06b)
    receive.py   reading a client's frames as a tolerant receiver, with a fast path (DPR-06b)
    log.py       <session>/link.jsonl (DPR-06b)
"""
from .server import LinkServer

__all__ = ["LinkServer"]
