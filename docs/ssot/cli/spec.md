# CLI Specification

The `alchemy` command accepts an input RAW, destination TIFF, required built-in-compatible CUBE path, and optional EV. It runs corrected-v2 with the same native decoder and Rust core as the browser.

Text output is concise and human-readable. JSON output is structured and contains no ANSI color. `--json` aliases `--output json`; `--color auto|always|never` controls text ANSI behavior.

Read, decode, LUT, processing, and write failures exit nonzero. A failure before persistence does not create a successful output file.
Decode failures use product language that identifies the input and suggests damage or unsupported camera format without exposing LibRaw exception types or numeric error codes.
