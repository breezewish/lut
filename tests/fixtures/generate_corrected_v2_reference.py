"""Print implementation-independent corrected-v2 reference vectors.

This script intentionally uses only Python's standard library and float64
arithmetic. It follows the constants and equations in the processing spec,
not the Rust implementation. Regenerate the committed JSON from the repository
root when the corrected-v2 contract intentionally changes:

    python3 tests/fixtures/generate_corrected_v2_reference.py
"""

from __future__ import annotations

import json
import math


PROPHOTO_TO_V_GAMUT = (
    (1.115_908_7, -0.042_472_865, -0.073_432_505),
    (-0.028_517_72, 0.936_791_24, 0.091_724_73),
    (0.012_854_77, -0.008_144_919, 0.995_291_2),
)
PROPHOTO_TO_SRGB = (
    (2.034_192_6, -0.727_419_8, -0.306_765_53),
    (-0.228_810_76, 1.231_729_3, -0.002_921_616),
    (-0.008_564_928, -0.153_272_58, 1.161_839),
)
LUT_VERTICES = (
    (0.01, 0.02, 0.03),
    (0.11, 0.12, 0.13),
    (0.21, 0.22, 0.23),
    (0.31, 0.32, 0.33),
    (0.41, 0.42, 0.43),
    (0.51, 0.52, 0.53),
    (0.61, 0.62, 0.63),
    (0.91, 0.92, 0.93),
)
CUBE = """LUT_3D_SIZE 2
0.01 0.02 0.03
0.11 0.12 0.13
0.21 0.22 0.23
0.31 0.32 0.33
0.41 0.42 0.43
0.51 0.52 0.53
0.61 0.62 0.63
0.91 0.92 0.93
"""


def matrix_multiply(matrix: tuple[tuple[float, ...], ...], rgb: list[float]) -> list[float]:
    return [sum(coefficient * channel for coefficient, channel in zip(row, rgb)) for row in matrix]


def encode_v_log(linear: float) -> float:
    if linear < 0.01:
        return 5.6 * linear + 0.125
    return 0.241_514 * math.log10(linear + 0.008_73) + 0.598_206


def srgb_oetf(linear: float) -> float:
    if linear <= 0.003_130_8:
        return linear * 12.92
    return 1.055 * linear ** (1.0 / 2.4) - 0.055


def render_base(linear_prophoto: list[float]) -> list[float]:
    linear_srgb = matrix_multiply(PROPHOTO_TO_SRGB, linear_prophoto)
    luminance = sum(
        coefficient * channel
        for coefficient, channel in zip((0.2126, 0.7152, 0.0722), linear_srgb)
    )
    scale = 1.0 / (1.0 + luminance) if luminance > 0.0 else 1.0
    return [srgb_oetf(max(channel * scale, 0.0)) for channel in linear_srgb]


def vertex(red: int, green: int, blue: int) -> tuple[float, float, float]:
    return LUT_VERTICES[blue * 4 + green * 2 + red]


def weighted(vertices: tuple[tuple[tuple[float, ...], float], ...]) -> list[float]:
    return [
        sum(value[channel] * weight for value, weight in vertices)
        for channel in range(3)
    ]


def sample_lut(rgb: list[float]) -> list[float]:
    red, green, blue = [min(1.0, max(0.0, value)) for value in rgb]
    c000 = vertex(0, 0, 0)
    c111 = vertex(1, 1, 1)
    if red >= green:
        if green >= blue:
            vertices = ((c000, 1 - red), (vertex(1, 0, 0), red - green), (vertex(1, 1, 0), green - blue), (c111, blue))
        elif red >= blue:
            vertices = ((c000, 1 - red), (vertex(1, 0, 0), red - blue), (vertex(1, 0, 1), blue - green), (c111, green))
        else:
            vertices = ((c000, 1 - blue), (vertex(0, 0, 1), blue - red), (vertex(1, 0, 1), red - green), (c111, green))
    elif red >= blue:
        vertices = ((c000, 1 - green), (vertex(0, 1, 0), green - red), (vertex(1, 1, 0), red - blue), (c111, blue))
    elif green >= blue:
        vertices = ((c000, 1 - green), (vertex(0, 1, 0), green - blue), (vertex(0, 1, 1), blue - red), (c111, red))
    else:
        vertices = ((c000, 1 - blue), (vertex(0, 0, 1), blue - green), (vertex(0, 1, 1), green - red), (c111, red))
    return weighted(vertices)


def quantize(value: float, maximum: int) -> int:
    return math.floor(min(1.0, max(0.0, value)) * maximum + 0.5)


def make_case(name: str, ev: float, pixels: list[list[int]]) -> dict[str, object]:
    base_rgba: list[int] = []
    lut_rgba: list[int] = []
    lut_rgb16: list[int] = []
    gain = 2.0**ev
    for encoded in pixels:
        linear = [channel / 65_535.0 * gain for channel in encoded]
        base = render_base(linear)
        lut = sample_lut([encode_v_log(value) for value in matrix_multiply(PROPHOTO_TO_V_GAMUT, linear)])
        base_rgba.extend([*(quantize(value, 255) for value in base), 255])
        lut_rgba.extend([*(quantize(value, 255) for value in lut), 255])
        lut_rgb16.extend(quantize(value, 65_535) for value in lut)
    return {
        "name": name,
        "ev": ev,
        "width": len(pixels),
        "height": 1,
        "pixels": [channel for pixel in pixels for channel in pixel],
        "base_rgba": base_rgba,
        "lut_rgba": lut_rgba,
        "lut_rgb16": lut_rgb16,
    }


fixture = {
    "schema_version": 1,
    "description": "Float64 reference derived independently from the corrected-v2 specification.",
    "cube": CUBE,
    "cases": [
        make_case(
            "ev-zero-primaries-and-wide-gamut",
            0.0,
            [
                [0, 0, 0],
                [32_768, 32_768, 32_768],
                [65_535, 0, 0],
                [0, 65_535, 0],
                [0, 0, 65_535],
                [1_234, 34_567, 60_000],
            ],
        ),
        make_case(
            "positive-ev-hdr",
            2.0,
            [[20_000, 30_000, 40_000], [50_000, 1_000, 20_000], [65_535, 65_535, 65_535]],
        ),
        make_case(
            "negative-ev-low-light",
            -4.0,
            [[1, 2, 3], [8_000, 10_000, 12_000], [65_535, 32_768, 4_096]],
        ),
    ],
}

print(json.dumps(fixture, indent=2) + "\n", end="")
