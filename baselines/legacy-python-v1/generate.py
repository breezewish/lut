"""Regenerate the frozen Raw Alchemy 0.4.2 manual-EV baselines.

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
LUT_ROOT = ROOT / "vendor/V-Log-Alchemy/Luts"
LUT_MANIFEST = ROOT / "assets/luts.json"
OUTPUT = Path(__file__).with_name("linear-all-looks-ev0.npz")
MANIFEST = Path(__file__).with_name("manifest.json")

sys.path.insert(0, str(RAW_ALCHEMY / "src"))
from raw_alchemy import utils  # noqa: E402


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decode(half_size: bool) -> np.ndarray:
    with rawpy.imread(str(RAW)) as raw:
        return raw.postprocess(
            gamma=(1, 1),
            no_auto_bright=True,
            use_camera_wb=True,
            output_bps=16,
            output_color=rawpy.ColorSpace.ProPhoto,
            bright=1.0,
            highlight_mode=2,
            demosaic_algorithm=rawpy.DemosaicAlgorithm.AAHD,
            half_size=half_size,
        )


def legacy_stages(
    rgb16: np.ndarray, matrix: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
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

    gamut = boost.copy()
    utils.apply_matrix_inplace(gamut, matrix)

    log_input = gamut.copy()
    np.maximum(log_input, 1e-6, out=log_input)
    vlog = colour.cctf_encoding(log_input, function="V-Log")
    return exposure, boost, gamut, vlog


def main() -> None:
    lut_manifest = json.loads(LUT_MANIFEST.read_text(encoding="utf-8"))
    looks = lut_manifest["luts"]
    matrix = colour.matrix_RGB_to_RGB(
        colour.RGB_COLOURSPACES["ProPhoto RGB"],
        colour.RGB_COLOURSPACES["V-Gamut"],
    )

    rgb16 = decode(half_size=False)
    exposure, boost, gamut, vlog = legacy_stages(rgb16, matrix)
    preview_rgb16 = decode(half_size=True)
    _, _, _, preview_vlog = legacy_stages(preview_rgb16, matrix)

    lut_outputs = []
    final_uint16 = []
    preview_srgb = []
    for look in looks:
        lut_path = LUT_ROOT / look["file"]
        lut = colour.read_LUT(str(lut_path))
        table = np.asarray(lut.table, dtype=np.float32)

        output = np.ascontiguousarray(vlog, dtype=np.float32)
        utils.apply_lut_inplace(output, table, lut.domain[0], lut.domain[1])
        lut_outputs.append(output)
        final_uint16.append((np.clip(output, 0.0, 1.0) * 65535).astype(np.uint16))

        preview = np.ascontiguousarray(preview_vlog, dtype=np.float32)
        utils.apply_lut_inplace(preview, table, lut.domain[0], lut.domain[1])
        np.clip(preview, 0.0, 1.0, out=preview)
        utils.bt709_to_srgb_inplace(preview)
        preview_srgb.append(preview)

    lut_outputs = np.stack(lut_outputs)
    final_uint16 = np.stack(final_uint16)
    preview_srgb = np.stack(preview_srgb)

    np.savez_compressed(
        OUTPUT,
        rgb16=rgb16,
        exposure=exposure,
        boost=boost,
        gamut=gamut,
        vlog=vlog,
        lut_outputs=lut_outputs,
        final_uint16=final_uint16,
        preview_rgb16=preview_rgb16,
        preview_srgb=preview_srgb,
        matrix=matrix,
    )
    manifest = {
        "schemaVersion": 2,
        "mode": "legacy-python-v1",
        "recipe": {
            "exposureEv": 0.0,
            "lensCorrection": False,
            "log": "V-Log",
            "luts": [look["id"] for look in looks],
        },
        "sources": {
            "raw": {"path": str(RAW.relative_to(ROOT)), "sha256": sha256(RAW)},
            "luts": [
                {
                    "id": look["id"],
                    "path": str((LUT_ROOT / look["file"]).relative_to(ROOT)),
                    "sha256": sha256(LUT_ROOT / look["file"]),
                }
                for look in looks
            ],
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
                "lut_outputs": lut_outputs,
                "final_uint16": final_uint16,
                "preview_rgb16": preview_rgb16,
                "preview_srgb": preview_srgb,
            }.items()
        },
        "fixture": {"path": OUTPUT.name, "sha256": sha256(OUTPUT)},
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
