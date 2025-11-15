"""
Data Replayer with Terminal UI
Replays recorded mouse data through WebSocket for testing maze scenes

Features:
- Load recorded data files (TSV format)
- Terminal UI with playback controls
- Play/pause/stop/seek controls
- Speed control (0.1x to 10x)
- Loop mode
- Real-time playback at original sampling rate (20 Hz)
"""

import asyncio
import os
import time
from typing import Optional, Dict, Any, List
from dataclasses import dataclass


@dataclass
class DataFrame:
    """Single frame of recorded data"""
    x: float
    y: float
    face_angle: float
    dx: float
    dy: float
    lick: int
    time_stamp: int
    maze_type: str

    @classmethod
    def from_line(cls, line: str) -> Optional['DataFrame']:
        """Parse a line from the data file

        Format: x, y, face_angle, dx, dy, lick, time_stamp, maze_type
        """
        try:
            parts = line.strip().split('\t')
            if len(parts) < 6:  # At minimum need position and angles
                return None

            return cls(
                x=float(parts[0]),
                y=float(parts[1]),
                face_angle=float(parts[2]),
                dx=float(parts[3]),
                dy=float(parts[4]),
                lick=int(parts[5]) if len(parts) > 5 else 0,
                time_stamp=int(parts[6]) if len(parts) > 6 else 0,
                maze_type=parts[7] if len(parts) > 7 else "unknown"
            )
        except (ValueError, IndexError) as e:
            # Skip lines that can't be parsed
            return None

    def to_serial_data(self) -> Dict[str, Any]:
        """Convert to serial_data format for WebSocket"""
        return {
            "x": self.x,
            "y": self.y,
            "z": 0.0,  # No Z data in file, use 0
            "face_angle": self.face_angle,
            "dx": self.dx,
            "dy": self.dy,
            "lick": self.lick,
            "time_stamp": self.time_stamp,
            "maze_type": self.maze_type
        }


class DataReplayer:
    """Replays recorded data with playback controls"""

    def __init__(self):
        self.frames: List[DataFrame] = []
        self.current_index: int = 0
        self.is_playing: bool = False
        self.is_looping: bool = False
        self.speed: float = 1.0
        self.filename: Optional[str] = None
        self.last_frame_time: float = 0
        self.start_time: float = 0

    def load_file(self, filepath: str) -> bool:
        """Load data file"""
        try:
            if not os.path.exists(filepath):
                return False

            self.frames = []
            with open(filepath, 'r') as f:
                for line in f:
                    frame = DataFrame.from_line(line)
                    if frame:
                        self.frames.append(frame)

            self.filename = os.path.basename(filepath)
            self.current_index = 0
            self.is_playing = False
            return len(self.frames) > 0

        except Exception as e:
            print(f"Error loading file: {e}")
            return False

    def play(self):
        """Start playback"""
        self.is_playing = True
        self.last_frame_time = time.time()

    def pause(self):
        """Pause playback"""
        self.is_playing = False

    def stop(self):
        """Stop playback and reset"""
        self.is_playing = False
        self.current_index = 0

    def restart(self):
        """Restart from beginning"""
        self.current_index = 0
        self.last_frame_time = time.time()
        if not self.is_playing:
            self.play()

    def seek(self, frames: int):
        """Seek forward or backward by number of frames"""
        new_index = self.current_index + frames
        self.current_index = max(0, min(new_index, len(self.frames) - 1))

    def set_speed(self, speed: float):
        """Set playback speed (0.1x to 10x)"""
        self.speed = max(0.1, min(speed, 10.0))

    def toggle_loop(self):
        """Toggle loop mode"""
        self.is_looping = not self.is_looping

    async def get_next_frame(self) -> Optional[Dict[str, Any]]:
        """Get next frame if playing, respecting timing and speed"""
        if not self.frames or not self.is_playing:
            await asyncio.sleep(0.01)  # Small delay when paused
            return None

        # Check if we've reached the end
        if self.current_index >= len(self.frames):
            if self.is_looping:
                self.current_index = 0
            else:
                self.is_playing = False
                return None

        # Get current frame
        frame = self.frames[self.current_index]

        # Calculate time to wait based on original sampling rate and speed
        # Original rate: 20 Hz = 50ms between frames
        base_delay = 0.050  # 50ms
        actual_delay = base_delay / self.speed

        # Wait for the right time
        current_time = time.time()
        elapsed = current_time - self.last_frame_time

        if elapsed < actual_delay:
            await asyncio.sleep(actual_delay - elapsed)

        self.last_frame_time = time.time()
        self.current_index += 1

        return frame.to_serial_data()

    def get_status(self) -> Dict[str, Any]:
        """Get current playback status"""
        if not self.frames:
            return {
                "loaded": False,
                "filename": None,
                "total_frames": 0,
                "current_frame": 0,
                "progress": 0.0,
                "is_playing": False,
                "is_looping": False,
                "speed": self.speed
            }

        total_frames = len(self.frames)
        progress = (self.current_index / total_frames * 100) if total_frames > 0 else 0

        # Calculate time
        total_time = total_frames * 0.050  # 20 Hz = 50ms per frame
        current_time = self.current_index * 0.050

        current_frame = self.frames[self.current_index] if self.current_index < total_frames else None

        return {
            "loaded": True,
            "filename": self.filename,
            "total_frames": total_frames,
            "current_frame": self.current_index,
            "progress": progress,
            "current_time": current_time,
            "total_time": total_time,
            "is_playing": self.is_playing,
            "is_looping": self.is_looping,
            "speed": self.speed,
            "last_data": current_frame.to_serial_data() if current_frame else None
        }


# Terminal UI removed - use web dashboard at http://localhost:8766 instead