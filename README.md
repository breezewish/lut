# RAW Alchemy

RAW Alchemy is a private, static browser color lab. It decodes camera RAW files locally, compares a neutral base rendering with a built-in V-Log Alchemy look, and exports 16-bit TIFF files without uploading photos.

## Product behavior

- Select or drop one or many RAW files.
- See the embedded camera JPEG first, then a color-consistent half-size preview.
- Compare `Base` and `LUT` views on the same screen.
- Choose one of 27 pinned V-Log Alchemy creative looks and adjust exposure from -4 to +4 EV.
- Export one TIFF or a sequential batch as a ZIP.
- Keep all RAW bytes, decoded pixels, and output files in the browser.

The base view converts LibRaw ProPhoto D65 Linear to linear sRGB, applies a neutral luminance shoulder, then applies the sRGB transfer function. The LUT view applies exposure, the fixed ProPhoto D65 to V-Gamut D65 matrix, negative-preserving V-Log, domain-boundary clamping, and tetrahedral interpolation.

The source CUBE files do not declare their output gamut or transfer function. RAW Alchemy therefore labels the display assumption in the UI and does not attach a misleading ICC profile to TIFF exports.

## Development

Prerequisites are Git, Node.js 24, Rust 1.92, `wasm-pack` 0.13.1, and Docker or Podman. The container builds the pinned LibRaw fork with the minimal project-owned browser wrapper, Emscripten 5.0.7, one thread, portable C++17 arithmetic, explicit color-matrix FMA, and no `fast-math`; the Rust color core uses WASM SIMD.

```sh
git submodule update --init --recursive
npm ci
cargo install wasm-pack --version 0.13.1 --locked
npm run dev
```

`npm run dev` prepares and verifies LUT assets, builds LibRaw WASM, builds the Rust color core, and starts Vite. Generated WASM, copied LUTs, and `dist/` are ignored.

Create a production bundle with:

```sh
npm run build
```

The resulting `dist/` directory is a static site. Serve it over HTTPS. The single-threaded build does not require cross-origin isolation headers. `VITE_BASE_PATH` selects a non-root deployment path when needed.

## Deployment

Every successful `main` verification deploys the repository-path bundle to [GitHub Pages](https://breezewish.github.io/lut/). The workflow builds and exercises the site at `/lut/`, uploads `dist/` as the immutable Pages artifact, and publishes it through GitHub's Pages deployment API. No generated files or deployment branch are committed.

## Native CLI

The CLI uses the same corrected-v2 Rust core and pinned native LibRaw source:

```sh
cargo run -p alchemy-cli -- \
  photo.dng output.tif \
  --lut vendor/V-Log-Alchemy/Luts/Fujifilm/FLog2C_to_CLASSIC-Neg_VLog.cube \
  --ev 0.5 \
  --output text \
  --color auto
```

Use `--json` as an alias for `--output json`. JSON never contains ANSI color.

## Verification

```sh
cargo fmt --all --check
cargo test --workspace
cargo test --workspace --release
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p alchemy-core
cc -std=c11 -Wall -Wextra -Werror \
  -Icrates/alchemy-core/include tests/c-api-smoke.c \
  -Ltarget/debug -lalchemy_core -lm -Wl,-rpath,"$PWD/target/debug" \
  -o target/c-api-smoke
target/c-api-smoke
npm test
npm run build
npm run test:e2e
```

The frozen Python baseline is regenerated only when intentionally changing legacy migration evidence:

```sh
uv run --project baselines/legacy-python-v1 \
  baselines/legacy-python-v1/generate.py
```

See [docs/README.md](docs/README.md) for the product, technical, and test source of truth.
The reusable Rust core also publishes a minimal C ABI in
[crates/alchemy-core/include/alchemy.h](crates/alchemy-core/include/alchemy.h).
