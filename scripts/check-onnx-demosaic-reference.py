#!/usr/bin/env python3
"""Compare a browser demosaic report with Studio's native ONNX pipeline.

The browser report contains deterministic, evenly spaced samples from the
complete float32 RGB frame. This script rebuilds the same black-subtracted
sensor input with rawpy, invokes the unmodified Studio demosaic module, and
reports the corresponding RGB16 code-value differences.

Hot-pixel repair and highlight reconstruction are deliberately outside this
comparison: they are separate Studio preprocessing stages and are not part of
the RCD or Markesteijn ONNX graphs under test.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
import rawpy


def main() -> None:
    # Linux wheels keep CUDA/cuDNN in separate Python packages. Loading them
    # here makes Studio's normal provider selection observe the real native
    # CUDA path instead of silently falling back to CPU.
    ort.preload_dlls()
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--browser-report")
    parser.add_argument("--studio-src", required=True)
    parser.add_argument("--output")
    parser.add_argument("--rgb16-output")
    args = parser.parse_args()
    if not args.browser_report and not args.rgb16_output:
        parser.error("provide --browser-report, --rgb16-output, or both")

    sys.path.insert(0, str(Path(args.studio_src).resolve()))
    from raw_alchemy.colorspace_matrices import cam_to_prophoto_matrix

    with rawpy.imread(args.fixture) as raw:
        pattern = np.asarray(raw.raw_pattern)
        mosaic = raw.raw_image_visible.astype(np.float32)
        black = np.asarray(raw.black_level_per_channel, dtype=np.float32)
        white = np.float32(raw.white_level)
        wb = np.asarray(raw.camera_whitebalance, dtype=np.float32)
        matrix = cam_to_prophoto_matrix(
            np.asarray(raw.rgb_xyz_matrix, dtype=np.float64)
        ).astype(np.float32)

    black_map = np.empty(pattern.shape, dtype=np.float32)
    for row in range(pattern.shape[0]):
        for column in range(pattern.shape[1]):
            black_map[row, column] = black[min(int(pattern[row, column]), 3)]
    tiled_black = np.tile(
        black_map,
        (
            (mosaic.shape[0] + pattern.shape[0] - 1) // pattern.shape[0],
            (mosaic.shape[1] + pattern.shape[1] - 1) // pattern.shape[1],
        ),
    )[: mosaic.shape[0], : mosaic.shape[1]]
    np.subtract(mosaic, tiled_black, out=mosaic)
    np.maximum(mosaic, np.float32(0), out=mosaic)
    np.divide(mosaic, white - tiled_black, out=mosaic)

    green = wb[1] if wb[1] > 0 else np.float32(1)
    wb3 = np.asarray([wb[0] / green, 1, wb[2] / green], dtype=np.float32)
    if pattern.shape == (2, 2):
        from raw_alchemy.onnx.rcd_demosaic import rcd_demosaic

        algorithm = "RCD"
        image = rcd_demosaic(mosaic, pattern, wb3=wb3, cam_mat=matrix)
    elif pattern.shape == (6, 6):
        from raw_alchemy.onnx.xtrans_demosaic import xtrans_markesteijn_demosaic

        algorithm = "Markesteijn"
        image = xtrans_markesteijn_demosaic(mosaic, pattern)
        image *= wb3
        image = np.matmul(image, matrix.T)
        np.clip(image, 0, 1, out=image)
    else:
        raise RuntimeError(f"unsupported CFA pattern {pattern.shape}")

    if args.rgb16_output:
        rgb16 = np.rint(np.clip(image, 0, 1) * 65535).astype("<u2")
        Path(args.rgb16_output).write_bytes(rgb16.tobytes())
    if not args.browser_report:
        print(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "fixture": str(Path(args.fixture).resolve()),
                    "algorithm": algorithm,
                    "provider": _provider(algorithm),
                    "width": int(image.shape[1]),
                    "height": int(image.shape[0]),
                    "rgb16Samples": int(image.size),
                    "rgb16Output": str(Path(args.rgb16_output).resolve()),
                },
                indent=2,
            )
            + "\n",
            end="",
        )
        return

    report = json.loads(Path(args.browser_report).read_text(encoding="utf-8"))
    browser = report["coldRun"]["report"]["demosaic"]
    validation = browser["validation"]

    if algorithm != browser["algorithm"]:
        raise RuntimeError(
            f"browser used {browser['algorithm']}, native path used {algorithm}"
        )
    flat = image.reshape(-1)
    indices = np.asarray(validation["sampleIndices"], dtype=np.int64)
    browser_values = np.asarray(validation["sampleValues"], dtype=np.float32)
    native_values = flat[indices]
    float_delta = np.abs(browser_values - native_values)
    browser_codes = np.rint(np.clip(browser_values, 0, 1) * 65535).astype(np.int32)
    native_codes = np.rint(np.clip(native_values, 0, 1) * 65535).astype(np.int32)
    code_delta = np.abs(browser_codes - native_codes)
    largest = np.argsort(code_delta)[-min(20, indices.size) :][::-1]
    result = {
        "schemaVersion": 1,
        "fixture": str(Path(args.fixture).resolve()),
        "algorithm": algorithm,
        "provider": _provider(algorithm),
        "sampleCount": int(indices.size),
        "floatAbsoluteDelta": summary(float_delta),
        "rgb16CodeDelta": summary(code_delta),
        "rgb16SamplesOverOneCode": int(np.count_nonzero(code_delta > 1)),
        "largestDifferences": [
            {
                "flatIndex": int(indices[position]),
                "row": int(indices[position] // (image.shape[1] * 3)),
                "column": int((indices[position] // 3) % image.shape[1]),
                "channel": int(indices[position] % 3),
                "browser": float(browser_values[position]),
                "native": float(native_values[position]),
                "rgb16CodeDelta": int(code_delta[position]),
            }
            for position in largest
            if code_delta[position] > 0
        ],
    }
    encoded = json.dumps(result, indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(encoded, encoding="utf-8")
    print(encoded, end="")


def _provider(algorithm: str) -> str | None:
    if algorithm == "RCD":
        from raw_alchemy.onnx import rcd_demosaic

        return rcd_demosaic._session_provider
    from raw_alchemy.onnx import xtrans_demosaic

    return xtrans_demosaic._session_provider


def summary(values: np.ndarray) -> dict[str, float]:
    return {
        "mean": float(np.mean(values)),
        "p95": float(np.percentile(values, 95)),
        "p99": float(np.percentile(values, 99)),
        "maximum": float(np.max(values)),
    }


if __name__ == "__main__":
    main()
