# CLI Specification

The `lutify` command accepts an input RAW, destination TIFF, required built-in-compatible CUBE path, optional EV, and optional relative `--temperature` and `--tint` values. Zero on both white-balance axes preserves As Shot. It runs corrected-v2 with the same native decoder and Rust core as the browser and writes an uncompressed RGB16 TIFF.

Text output is concise and human-readable. JSON output is structured and contains no ANSI color. `--json` aliases `--output json`; `--color auto|always|never` controls text ANSI behavior.

Read, decode, LUT, processing, and write failures exit nonzero. A failure before persistence does not create a successful output file.
Decode failures use product language that identifies the input and suggests damage or unsupported camera format without exposing LibRaw exception types or numeric error codes.
