from dataclasses import dataclass, field
from typing import List, Optional
import numpy as np

@dataclass
class HallwayState:
    position: List[float] = field(default_factory=lambda: [0, 0, 2.0, 0])
    water: int = 0
    timestamp: str = ""
    numrewards: int = 0
    isTrialStart: bool = True
    isTrialEnd: bool = False
    trialTimer: float = 0
    rewarding: bool = False
    white: int = 1
    currentWorld: int = 1
    velocity: List[float] = field(default_factory=lambda: [0, 0, 0, 0])