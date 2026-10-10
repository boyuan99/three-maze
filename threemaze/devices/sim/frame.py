"""Framing of device protocol v1 lines (docs/protocol/device-v1.md section 3): a record of
printable ASCII, '*', two upper-case hexadecimal digits of CRC-8/SMBUS over the record, LF."""

U32 = 1 << 32


def crc8(data: bytes) -> int:
    """CRC-8/SMBUS: polynomial 0x07, initial value 0, no reflection, no final XOR (rule F3)."""
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def frame(record: str) -> bytes:
    """The line for a record, without its line ending."""
    data = record.encode("ascii")
    return data + b"*%02X" % crc8(data)


def unframe(line: bytes) -> str | None:
    """The record of a line whose checksum is right, else None. The line may end in LF or CRLF;
    the checksum digits may be in either case."""
    line = line.rstrip(b"\n").rstrip(b"\r")
    if len(line) < 3 or line[-3:-2] != b"*":
        return None
    record, digits = line[:-3], line[-2:]
    if any(d not in b"0123456789ABCDEFabcdef" for d in digits):
        return None
    value = int(digits.decode("ascii"), 16)
    if any(b < 0x20 or b > 0x7E or b == 0x2A for b in record) or crc8(record) != value:
        return None
    return record.decode("ascii")


def int32(value: int) -> int:
    """value modulo 2^32 as a signed 32-bit integer (running totals wrap, rule D6)."""
    return (value + (1 << 31)) % U32 - (1 << 31)
