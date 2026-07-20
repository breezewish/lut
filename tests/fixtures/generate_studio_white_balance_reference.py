"""Regenerate the frozen Raw Alchemy Studio white-balance matrix oracle."""

import json

import colour
import numpy as np


STUDIO_COMMIT = "c9823146ba674be52d62f4c55b4c649f796bafd0"
D65_XY = tuple(
    float(value)
    for value in colour.CCS_ILLUMINANTS["CIE 1931 2 Degree Standard Observer"]["D65"]
)
D65_CCT = 6504.0
D65_TO_D50_BRADFORD = np.array(
    [
        [1.0478112, 0.0228866, -0.0501270],
        [0.0295424, 0.9904844, -0.0170491],
        [-0.0092345, 0.0150436, 0.7521316],
    ]
)
PROPHOTO_TO_XYZ_D50 = np.array(
    [
        [0.7976749, 0.1351917, 0.0313534],
        [0.2880402, 0.7118741, 0.0000857],
        [0.0, 0.0, 0.8252100],
    ]
)
PROPHOTO_TO_XYZ_D65 = np.linalg.inv(D65_TO_D50_BRADFORD) @ PROPHOTO_TO_XYZ_D50


def studio_matrix(temperature: float, tint: float) -> np.ndarray:
    if temperature == 0 and tint == 0:
        return np.eye(3)
    target_mired = np.clip(
        1_000_000 / D65_CCT + temperature,
        1_000_000 / 25_000,
        1_000_000 / 1_500,
    )
    uv = colour.CCT_to_uv(
        np.array([1_000_000 / target_mired, tint * -0.0005]),
        method="Ohno 2013",
    )
    target_xy = colour.UCS_uv_to_xy(uv)
    adaptation = colour.adaptation.matrix_chromatic_adaptation_VonKries(
        colour.xy_to_XYZ(D65_XY),
        colour.xy_to_XYZ(target_xy),
        transform="Bradford",
    )
    return np.linalg.inv(PROPHOTO_TO_XYZ_D65) @ adaptation @ PROPHOTO_TO_XYZ_D65


cases = []
for temperature, tint in [
    (0, 0),
    (-100, 0),
    (100, 0),
    (0, -100),
    (0, 100),
    (-63, 37),
    (42, -58),
    (100, 100),
    (-100, -100),
]:
    cases.append(
        {
            "temperature": temperature,
            "tint": tint,
            "matrix": studio_matrix(temperature, tint).tolist(),
        }
    )

print(json.dumps({"studio_commit": STUDIO_COMMIT, "cases": cases}, indent=2))
