"""
Socket-based serial adapter for Windows compatibility

Allows three-maze backend to connect to virtual_sensor via TCP socket
instead of actual serial port, providing cross-platform testing capability.
"""
import socket
import time
from typing import Optional


class SocketSerialAdapter:
    """
    Adapter that mimics pyserial.Serial interface but uses socket connection.

    This allows connecting to virtual_sensor on Windows where pty is not available.
    Compatible with existing serial-based experiments with minimal changes.
    """

    def __init__(self, host='localhost', port=5555, baudrate=115200, timeout=1.0, write_timeout=1.0):
        """
        Initialize socket-based serial adapter.

        Args:
            host: Target host (default: localhost)
            port: Target port (default: 5555, matches virtual_sensor_windows)
            baudrate: Ignored (for API compatibility)
            timeout: Read timeout in seconds
            write_timeout: Write timeout in seconds
        """
        self.host = host
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.write_timeout = write_timeout

        self.socket: Optional[socket.socket] = None
        self.is_open = False
        self._buffer = b""

    def open(self):
        """Connect to the socket server."""
        if self.is_open:
            return

        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.settimeout(self.timeout)
            self.socket.connect((self.host, self.port))
            self.is_open = True
            print(f"[SocketSerial] Connected to {self.host}:{self.port}")
        except Exception as e:
            raise IOError(f"Failed to connect to {self.host}:{self.port}: {e}")

    def close(self):
        """Close the socket connection."""
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
            self.socket = None
        self.is_open = False

    def write(self, data: bytes) -> int:
        """
        Write data to socket.

        Args:
            data: Bytes to write

        Returns:
            Number of bytes written
        """
        if not self.is_open or not self.socket:
            raise IOError("Socket not connected")

        try:
            self.socket.sendall(data)
            return len(data)
        except socket.timeout:
            raise IOError("Write timeout")
        except Exception as e:
            raise IOError(f"Write error: {e}")

    def read(self, size=1) -> bytes:
        """
        Read specified number of bytes from socket.

        Args:
            size: Number of bytes to read

        Returns:
            Bytes read (may be less than size if timeout)
        """
        if not self.is_open or not self.socket:
            raise IOError("Socket not connected")

        try:
            # Use buffer if available
            if len(self._buffer) >= size:
                result = self._buffer[:size]
                self._buffer = self._buffer[size:]
                return result

            # Read more data
            data = self.socket.recv(size - len(self._buffer))
            self._buffer += data

            # Return requested amount
            result = self._buffer[:size]
            self._buffer = self._buffer[size:]
            return result

        except socket.timeout:
            return b""
        except Exception as e:
            raise IOError(f"Read error: {e}")

    def readline(self, size=-1) -> bytes:
        """
        Read a line from socket (until '\n' or size limit).

        Args:
            size: Maximum bytes to read (-1 for unlimited)

        Returns:
            Line including newline character
        """
        if not self.is_open or not self.socket:
            raise IOError("Socket not connected")

        line = b""
        start_time = time.time()

        while True:
            # Check timeout
            if self.timeout and (time.time() - start_time) > self.timeout:
                break

            # Check size limit
            if size > 0 and len(line) >= size:
                break

            # Check buffer first
            if b'\n' in self._buffer:
                idx = self._buffer.index(b'\n')
                line += self._buffer[:idx + 1]
                self._buffer = self._buffer[idx + 1:]
                return line

            # Add buffer to line
            line += self._buffer
            self._buffer = b""

            # Read more data
            try:
                self.socket.settimeout(0.1)
                data = self.socket.recv(1)
                if not data:
                    break

                if data == b'\n':
                    line += data
                    return line
                else:
                    self._buffer += data

            except socket.timeout:
                continue
            except Exception:
                break

        return line

    @property
    def in_waiting(self) -> int:
        """
        Get number of bytes available to read.

        Returns:
            Number of bytes in buffer
        """
        if not self.is_open or not self.socket:
            return 0

        # Check socket for available data
        try:
            self.socket.settimeout(0)
            data = self.socket.recv(1024)
            if data:
                self._buffer += data
        except:
            pass
        finally:
            if self.socket:
                self.socket.settimeout(self.timeout)

        return len(self._buffer)

    def __enter__(self):
        """Context manager entry."""
        if not self.is_open:
            self.open()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.close()


# Alias for compatibility
class Serial(SocketSerialAdapter):
    """Alias to match pyserial.Serial interface."""
    pass
