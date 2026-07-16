#!/usr/bin/env python3
"""Measure the Studio-derived decode and its ONNX demosaic stage.

Run this with the Studio checkout's ``src`` on ``PYTHONPATH``. The script does
not modify that checkout and records whether RCD or Markesteijn was selected by
the real Studio decode entry point.
"""

from __future__ import annotations

import argparse
import gc
import json
import resource
import statistics
import time
from pathlib import Path

import numpy as np
import onnxruntime
import rawpy


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--output")
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--warmups", type=int, default=1)
    args = parser.parse_args()
    if args.samples < 1 or args.warmups < 0:
        parser.error("samples must be positive and warmups must be non-negative")

    fixture = str(Path(args.fixture).resolve())
    with rawpy.imread(fixture) as raw:
        pattern = raw.raw_pattern
        dimensions = [raw.sizes.width, raw.sizes.height]
        camera = f"{raw.camera_whitebalance!r}"
    if pattern is None:
        raise RuntimeError("fixture has no CFA pattern")

    demosaic_runs: list[float] = []
    if pattern.shape == (2, 2):
        from raw_alchemy.onnx import rcd_demosaic as demosaic_module

        algorithm = "RCD"
        function_name = "rcd_demosaic"
    elif pattern.shape == (6, 6):
        from raw_alchemy.onnx import xtrans_demosaic as demosaic_module

        algorithm = "Markesteijn"
        function_name = "xtrans_markesteijn_demosaic"
    else:
        raise RuntimeError(f"unsupported CFA pattern: {pattern.shape}")

    original = getattr(demosaic_module, function_name)

    def timed_demosaic(*arguments, **keywords):
        started_at = time.perf_counter()
        result = original(*arguments, **keywords)
        demosaic_runs.append((time.perf_counter() - started_at) * 1000)
        return result

    setattr(demosaic_module, function_name, timed_demosaic)
    from raw_alchemy.core import _rawpy_decode_to_prophoto

    runs = []
    summaries = []
    for index in range(args.warmups + args.samples):
        started_at = time.perf_counter()
        image = _rawpy_decode_to_prophoto(fixture)
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        if index >= args.warmups:
            runs.append(elapsed_ms)
            sample = image[::32, ::32]
            summaries.append(
                {
                    "channelMeans": sample.mean(axis=(0, 1)).tolist(),
                    "clippedFraction": float(
                        np.count_nonzero((sample == 0) | (sample == 1))
                        / sample.size
                    ),
                }
            )
        del image
        gc.collect()

    measured_demosaic = demosaic_runs[args.warmups :]
    report = {
        "schemaVersion": 1,
        "fixture": fixture,
        "fixtureBytes": Path(fixture).stat().st_size,
        "dimensions": dimensions,
        "cfaShape": list(pattern.shape),
        "cameraWhiteBalance": camera,
        "algorithm": algorithm,
        "providersAvailable": onnxruntime.get_available_providers(),
        "providerUsed": demosaic_module._session_provider,
        "warmups": args.warmups,
        "samples": args.samples,
        "totalMs": summarize(runs),
        "demosaicMs": summarize(measured_demosaic),
        "peakResidentMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        / 1024,
        "imageSignature": summaries[-1],
    }
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(encoded, encoding="utf-8")
    print(encoded, end="")


def summarize(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    position = (len(ordered) - 1) * 0.95
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    p95 = ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
    return {
        "median": statistics.median(ordered),
        "p95": p95,
        "min": ordered[0],
        "max": ordered[-1],
    }


if __name__ == "__main__":
    main()
