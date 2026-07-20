"""Print implementation-independent automatic-exposure reference vectors.

The fixtures reproduce the documented 7 x 7 matrix meter with Python's
standard library. They intentionally do not import browser implementation code.

Run from the repository root:

    python3 tests/fixtures/generate_auto_exposure_reference.py \
      > tests/fixtures/auto-exposure-reference.json
"""

from __future__ import annotations

import json
import math


GRID_SIZE = 7
HISTOGRAM_BINS = 1024
LINEAR_CODE_MAXIMUM = 65_535
TARGET_GRAY = 0.18
MAXIMUM_HIGHLIGHT = 6.0


def percentile(sorted_values: list[float], fraction: float) -> float:
    position = (len(sorted_values) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    mix = position - lower
    return sorted_values[lower] * (1.0 - mix) + sorted_values[upper] * mix


def expected_ev(width: int, height: int, pixels: list[int]) -> float:
    zone_sums = [0] * (GRID_SIZE * GRID_SIZE)
    zone_counts = [0] * (GRID_SIZE * GRID_SIZE)
    histogram = [0] * HISTOGRAM_BINS
    for index in range(width * height):
        red, green, blue = pixels[index * 3 : index * 3 + 3]
        luminance = min(
            LINEAR_CODE_MAXIMUM,
            max(0.0, 0.268_205_5 * red + 0.715_217_1 * green + 0.016_576_9 * blue),
        )
        x = index % width
        y = index // width
        zone = min(y * GRID_SIZE // height, GRID_SIZE - 1) * GRID_SIZE + min(
            x * GRID_SIZE // width, GRID_SIZE - 1
        )
        zone_sums[zone] += math.floor(luminance + 0.5)
        zone_counts[zone] += 1
        peak = max(red, green, blue)
        histogram[min(peak * HISTOGRAM_BINS // 65_536, HISTOGRAM_BINS - 1)] += 1

    zones = [
        (index, zone_sums[index] / (count * LINEAR_CODE_MAXIMUM))
        for index, count in enumerate(zone_counts)
        if count
    ]
    if not zones:
        return 0.0
    sorted_luminance = sorted(luminance for _, luminance in zones)
    low = percentile(sorted_luminance, 0.1)
    high = percentile(sorted_luminance, 0.9)
    center = (GRID_SIZE - 1) / 2
    sigma = GRID_SIZE / 2.5
    weighted_sum = 0.0
    total_weight = 0.0
    for index, luminance in zones:
        x = index % GRID_SIZE
        y = index // GRID_SIZE
        distance_squared = (x - center) ** 2 + (y - center) ** 2
        weight = 1.0 + math.exp(-distance_squared / (2.0 * sigma**2)) * 1.5
        if luminance > high:
            weight *= 0.2
        if luminance < low:
            weight *= 1.2
        weighted_sum += luminance * weight
        total_weight += weight
    weighted_luminance = weighted_sum / total_weight
    if weighted_luminance < 1e-6:
        return 0.0

    gain = TARGET_GRAY / weighted_luminance
    target = math.floor((width * height - 1) * 0.99)
    cumulative = 0
    highlight = 0.0
    for index, count in enumerate(histogram):
        cumulative += count
        if cumulative > target:
            highlight = (index + 1) / HISTOGRAM_BINS
            break
    if highlight > 1e-6 and highlight * gain > MAXIMUM_HIGHLIGHT:
        gain = MAXIMUM_HIGHLIGHT / highlight
    return math.log2(min(100.0, max(0.1, gain)))


def uniform(width: int, height: int, code: int) -> list[int]:
    return [code, code, code] * (width * height)


def zones(width: int, height: int) -> list[int]:
    pixels: list[int] = []
    for y in range(height):
        for x in range(width):
            zone_x = min(x * GRID_SIZE // width, GRID_SIZE - 1)
            zone_y = min(y * GRID_SIZE // height, GRID_SIZE - 1)
            distance = abs(zone_x - 3) + abs(zone_y - 3)
            code = max(256, 18_000 - distance * 2_200)
            pixels.extend((code, code // 2, code // 4))
    return pixels


def highlights(width: int, height: int) -> list[int]:
    pixels = uniform(width, height, 655)
    for index in (0, width - 1, width * (height - 1), width * height - 1):
        pixels[index * 3 : index * 3 + 3] = [52_428, 52_428, 52_428]
    return pixels


fixture_cases = [
    ("uniform-two-percent", 14, 14, uniform(14, 14, 1_311)),
    ("center-weighted-zones", 14, 14, zones(14, 14)),
    ("p99-highlight-limit", 14, 14, highlights(14, 14)),
    ("black", 7, 7, uniform(7, 7, 0)),
    ("non-divisible-zone-geometry", 10, 13, zones(10, 13)),
]

fixture = {
    "schema_version": 1,
    "description": "Independent matrix-metering vectors derived from the automatic-exposure specification.",
    "cases": [
        {
            "name": name,
            "width": width,
            "height": height,
            "pixels": pixels,
            "expected_ev": expected_ev(width, height, pixels),
        }
        for name, width, height, pixels in fixture_cases
    ],
}

print(json.dumps(fixture, indent=2) + "\n", end="")
