#!/usr/bin/env bash

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly OUTPUT_DIR="$ROOT/web/src/libraw"
readonly IMAGE="emscripten/emsdk:5.0.7"
readonly LIBRAW_COMMIT="0029e79482c3a133d3de72ff51117ca7d0a4ff43"
readonly JPEG_COMMIT="4e151a4ad91001b3aa8c2ece2205c15f487ce320"
readonly FMA_OVERRIDE_SHA256="4d17be3e69bd0995410c07181ea56f35353ee60aa47bfe2d874ff687f593a146"
readonly AAHD_MATH_SHA256="4e06458a46291439b3c3db0571fcb0a29d9d3a2ed4be75d98b9b2e46529cc7f2"
readonly BROWSER_WRAPPER_SHA256="$(sha256sum "$ROOT/crates/alchemy-libraw/src/browser_wrapper.cpp" | cut -d ' ' -f 1)"
readonly BUILD_ID="libraw-${LIBRAW_COMMIT}-wrapper-${BROWSER_WRAPPER_SHA256:0:12}-jpeg-${JPEG_COMMIT}-fma-${FMA_OVERRIDE_SHA256:0:12}-aahd-${AAHD_MATH_SHA256:0:12}-emcc-5.0.7-signed-char-wrapv-no-contract"
readonly JPEG_BUILD_DIR="$OUTPUT_DIR/.libjpeg-build"
readonly AAHD_OBJECT="$OUTPUT_DIR/.aahd_demosaic.o"

[[ "$(sha256sum "$ROOT/crates/alchemy-libraw/src/postprocessing_utils.cpp" | cut -d ' ' -f 1)" == "$FMA_OVERRIDE_SHA256" ]] \
  || { echo "LibRaw FMA override hash does not match $FMA_OVERRIDE_SHA256" >&2; exit 1; }
[[ "$(sha256sum "$ROOT/crates/alchemy-libraw/src/aahd_math_override.h" | cut -d ' ' -f 1)" == "$AAHD_MATH_SHA256" ]] \
  || { echo "LibRaw AAHD math override hash does not match $AAHD_MATH_SHA256" >&2; exit 1; }
[[ "$(git -C "$ROOT/vendor/LibRaw" rev-parse HEAD)" == "$LIBRAW_COMMIT" ]] \
  || { echo "vendor/LibRaw is not at $LIBRAW_COMMIT" >&2; exit 1; }
git -C "$ROOT/vendor/LibRaw" diff --quiet \
  || { echo "vendor/LibRaw has uncommitted source changes" >&2; exit 1; }
git -C "$ROOT/vendor/LibRaw" diff --cached --quiet \
  || { echo "vendor/LibRaw has staged source changes" >&2; exit 1; }
[[ "$(git -C "$ROOT/vendor/libjpeg-turbo" rev-parse HEAD)" == "$JPEG_COMMIT" ]] \
  || { echo "vendor/libjpeg-turbo is not at $JPEG_COMMIT" >&2; exit 1; }
git -C "$ROOT/vendor/libjpeg-turbo" diff --quiet \
  || { echo "vendor/libjpeg-turbo has uncommitted source changes" >&2; exit 1; }
git -C "$ROOT/vendor/libjpeg-turbo" diff --cached --quiet \
  || { echo "vendor/libjpeg-turbo has staged source changes" >&2; exit 1; }

if [[ -f "$OUTPUT_DIR/.build-id" ]] \
  && [[ "$(<"$OUTPUT_DIR/.build-id")" == "$BUILD_ID" ]] \
  && [[ -f "$OUTPUT_DIR/libraw.js" ]] \
  && [[ -f "$OUTPUT_DIR/libraw.wasm" ]]; then
  echo "LibRaw WASM is current ($BUILD_ID)."
  exit 0
fi

mkdir -p "$OUTPUT_DIR"
mapfile -d '' SOURCES < <(
  cd "$ROOT"
  find vendor/LibRaw/src -name '*.cpp' \
    ! -path '*/integration/*' \
    ! -name 'postprocessing_ph.cpp' \
    ! -name 'preprocessing_ph.cpp' \
    ! -name 'write_ph.cpp' \
    ! -path '*/demosaic/aahd_demosaic.cpp' \
    ! -path '*/postprocessing/postprocessing_utils.cpp' \
    -print0 | sort -z
)

cd "$ROOT"
rm -rf "$JPEG_BUILD_DIR"
"${CONTAINER_RUNTIME:-docker}" run --rm \
  -v "$ROOT:/workspace" \
  -w /workspace \
  "$IMAGE" \
  bash -lc \
    'emcmake cmake -S vendor/libjpeg-turbo -B web/src/libraw/.libjpeg-build \
      -DENABLE_SHARED=FALSE \
      -DENABLE_STATIC=TRUE \
      -DWITH_TURBOJPEG=FALSE \
      -DWITH_TOOLS=FALSE \
      -DWITH_TESTS=FALSE \
      -DWITH_JAVA=FALSE \
      -DWITH_SIMD=FALSE \
      -DCMAKE_BUILD_TYPE=Release \
    && cmake --build web/src/libraw/.libjpeg-build --parallel 2'

"${CONTAINER_RUNTIME:-docker}" run --rm \
  -v "$ROOT:/workspace" \
  -w /workspace \
  "$IMAGE" \
  em++ \
    -std=c++17 \
    -O3 \
    -fsigned-char \
    -fwrapv \
    -ffp-contract=off \
    -DLIBRAW_NODLL \
    -DUSE_JPEG \
    -DUSE_JPEG8 \
    -Ivendor/LibRaw \
    -Ivendor/libjpeg-turbo/src \
    -Iweb/src/libraw/.libjpeg-build \
    -include crates/alchemy-libraw/src/aahd_math_override.h \
    -c vendor/LibRaw/src/demosaic/aahd_demosaic.cpp \
    -o web/src/libraw/.aahd_demosaic.o

"${CONTAINER_RUNTIME:-docker}" run --rm \
  -v "$ROOT:/workspace" \
  -w /workspace \
  "$IMAGE" \
  em++ \
    -std=c++17 \
    -O3 \
    -fsigned-char \
    -fwrapv \
    -ffp-contract=off \
    -DLIBRAW_NODLL \
    -DUSE_JPEG \
    -DUSE_JPEG8 \
    -Ivendor/LibRaw \
    -Ivendor/libjpeg-turbo/src \
    -Iweb/src/libraw/.libjpeg-build \
    --bind \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sENVIRONMENT=worker \
    -sDISABLE_EXCEPTION_CATCHING=0 \
    -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=128MB \
    "${SOURCES[@]}" \
    crates/alchemy-libraw/src/postprocessing_utils.cpp \
    crates/alchemy-libraw/src/browser_wrapper.cpp \
    web/src/libraw/.aahd_demosaic.o \
    web/src/libraw/.libjpeg-build/libjpeg.a \
    -o web/src/libraw/libraw.js

rm -rf "$JPEG_BUILD_DIR" "$AAHD_OBJECT"
printf '%s' "$BUILD_ID" > "$OUTPUT_DIR/.build-id"
echo "Built $BUILD_ID."
