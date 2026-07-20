"""Generate the deterministic 12-bit packed CFA DNG decoder fixture."""

import struct
from pathlib import Path


WIDTH, HEIGHT = 1024, 1024
OUTPUT = Path(__file__).with_name("packed-12.dng")
BYTE, ASCII, SHORT, LONG, RATIONAL, SRATIONAL = 1, 2, 3, 4, 5, 10


def encode_values(kind, values):
    output = bytearray()
    for value in values:
        if kind in (BYTE, ASCII):
            output += struct.pack("<B", value & 0xFF)
        elif kind == SHORT:
            output += struct.pack("<H", value & 0xFFFF)
        elif kind == LONG:
            output += struct.pack("<I", value & 0xFFFFFFFF)
        elif kind == RATIONAL:
            output += struct.pack("<II", value[0], value[1])
        elif kind == SRATIONAL:
            output += struct.pack("<ii", value[0], value[1])
    return bytes(output)


pixels = bytearray()
for y in range(HEIGHT):
    for x in range(0, WIDTH, 2):
        first = (x * 17 + y * 31 + ((y & 1) * 2 + (x & 1)) * 251) & 0xFFF
        second_x = x + 1
        second = (
            second_x * 17
            + y * 31
            + ((y & 1) * 2 + (second_x & 1)) * 251
        ) & 0xFFF
        pixels += bytes(
            (first >> 4, ((first & 0xF) << 4) | (second >> 8), second & 0xFF)
        )

model = b"LUTifyPacked12\0"
matrix = [
    (1, 1),
    (0, 1),
    (0, 1),
    (0, 1),
    (1, 1),
    (0, 1),
    (0, 1),
    (0, 1),
    (1, 1),
]
entries = [
    (254, LONG, [0]),
    (256, LONG, [WIDTH]),
    (257, LONG, [HEIGHT]),
    (258, SHORT, [12]),
    (259, SHORT, [1]),
    (262, SHORT, [32803]),
    (273, LONG, [0]),
    (277, SHORT, [1]),
    (278, LONG, [HEIGHT]),
    (279, LONG, [len(pixels)]),
    (284, SHORT, [1]),
    (33421, SHORT, [2, 2]),
    (33422, BYTE, [0, 1, 1, 2]),
    (50706, BYTE, [1, 4, 0, 0]),
    (50707, BYTE, [1, 3, 0, 0]),
    (50708, ASCII, list(model)),
    (50713, SHORT, [2, 2]),
    (50714, SHORT, [0, 0, 0, 0]),
    (50717, LONG, [4095]),
    (50721, SRATIONAL, matrix),
    (50728, RATIONAL, [(1, 1), (1, 1), (1, 1)]),
    (50778, SHORT, [21]),
]

ifd_offset = 8
data_offset = ifd_offset + 2 + len(entries) * 12 + 4
encoded = [
    (tag, kind, len(values), encode_values(kind, values))
    for tag, kind, values in entries
]
placements = {}
cursor = data_offset
for tag, _, _, payload in encoded:
    if len(payload) > 4:
        placements[tag] = cursor
        cursor += len(payload) + len(payload) % 2
pixel_offset = cursor

output = bytearray(struct.pack("<2sHIH", b"II", 42, ifd_offset, len(entries)))
for tag, kind, count, payload in encoded:
    if tag == 273:
        payload = struct.pack("<I", pixel_offset)
    output += struct.pack("<HHI", tag, kind, count)
    output += (
        payload.ljust(4, b"\0")
        if len(payload) <= 4
        else struct.pack("<I", placements[tag])
    )
output += struct.pack("<I", 0)
for _, _, _, payload in encoded:
    if len(payload) > 4:
        output += payload
        if len(payload) % 2:
            output += b"\0"
output += pixels

OUTPUT.write_bytes(output)
print(f"wrote {OUTPUT} ({WIDTH}x{HEIGHT}, {len(output)} bytes)")
