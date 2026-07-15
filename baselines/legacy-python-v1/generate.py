"""Regenerate the frozen Raw Alchemy 0.4.2 manual-EV baseline.

Run from the repository root with:
    uv run --project baselines/legacy-python-v1 baselines/legacy-python-v1/generate.py

The committed fixture lets Rust tests consume the baseline without Python.
"""

from __future__ import annotations

import hashlib
import json
import platform
import sys
from pathlib import Path

import colour
import numba
import numpy as np
import rawpy


ROOT = Path(__file__).resolve().parents[2]
RAW_ALCHEMY = ROOT / "vendor/Raw-Alchemy"
RAW = ROOT / "tests/fixtures/linear.dng"
LUT = ROOT / "vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube"
OUTPUT = Path(__file__).with_name("linear-classic-negative-ev0.npz")
MANIFEST = Path(__file__).with_name("manifest.json")

sys.path.insert(0, str(RAW_ALCHEMY / "src"))
from raw_alchemy import utils  # noqa: E402


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    with rawpy.imread(str(RAW)) as raw:
        rgb16 = raw.postprocess(
            gamma=(1, 1),
            no_auto_bright=True,
            use_camera_wb=True,
            output_bps=16,
            output_color=rawpy.ColorSpace.ProPhoto,
            bright=1.0,
            highlight_mode=2,
            demosaic_algorithm=rawpy.DemosaicAlgorithm.AAHD,
        )

    exposure = rgb16.astype(np.float32) / 65535.0
    utils.apply_gain_inplace(exposure, 1.0)

    source = colour.RGB_COLOURSPACES["ProPhoto RGB"]
    boost = exposure.copy()
    utils.apply_saturation_and_contrast(
        boost,
        saturation=1.25,
        contrast=1.1,
        colourspace=source,
    )

    matrix = colour.matrix_RGB_to_RGB(source, colour.RGB_COLOURSPACES["V-Gamut"])
    gamut = boost.copy()
    utils.apply_matrix_inplace(gamut, matrix)

    log_input = gamut.copy()
    np.maximum(log_input, 1e-6, out=log_input)
    vlog = colour.cctf_encoding(log_input, function="V-Log")

    lut = colour.read_LUT(str(LUT))
    lut_input = np.ascontiguousarray(vlog, dtype=np.float32)
    table = np.asarray(lut.table, dtype=np.float32)
    utils.apply_lut_inplace(lut_input, table, lut.domain[0], lut.domain[1])
    final_uint16 = (np.clip(lut_input, 0.0, 1.0) * 65535).astype(np.uint16)

    np.savez_compressed(
        OUTPUT,
        rgb16=rgb16,
        exposure=exposure,
        boost=boost,
        gamut=gamut,
        vlog=vlog,
        lut=lut_input,
        final_uint16=final_uint16,
        matrix=matrix,
    )
    manifest = {
        "schemaVersion": 1,
        "mode": "legacy-python-v1",
        "recipe": {
            "exposureEv": 0.0,
            "lensCorrection": False,
            "log": "V-Log",
            "lut": str(LUT.relative_to(ROOT)),
        },
        "sources": {
            "raw": {"path": str(RAW.relative_to(ROOT)), "sha256": sha256(RAW)},
            "lut": {"path": str(LUT.relative_to(ROOT)), "sha256": sha256(LUT)},
            "rawAlchemyCommit": "10d4f5bded68d75d4db87cfeeddec1e5fea297d5",
        },
        "environment": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "numba": numba.__version__,
            "colour": colour.__version__,
            "rawpy": rawpy.__version__,
            "libraw": rawpy.libraw_version,
        },
        "arrays": {
            name: {
                "dtype": str(array.dtype),
                "shape": list(array.shape),
                "sha256": hashlib.sha256(array.tobytes()).hexdigest(),
            }
            for name, array in {
                "rgb16": rgb16,
                "exposure": exposure,
                "boost": boost,
                "gamut": gamut,
                "vlog": vlog,
                "lut": lut_input,
                "final_uint16": final_uint16,
            }.items()
        },
        "fixture": {"path": OUTPUT.name, "sha256": sha256(OUTPUT)},
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
