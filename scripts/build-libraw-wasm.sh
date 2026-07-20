#!/usr/bin/env bash

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly OUTPUT_DIR="$ROOT/web/src/libraw"
readonly THREAD_OUTPUT_DIR="$OUTPUT_DIR/threaded"
readonly IMAGE="emscripten/emsdk:5.0.7"
readonly LIBRAW_COMMIT="0029e79482c3a133d3de72ff51117ca7d0a4ff43"
readonly JPEG_COMMIT="4e151a4ad91001b3aa8c2ece2205c15f487ce320"
readonly FMA_OVERRIDE_SHA256="4d17be3e69bd0995410c07181ea56f35353ee60aa47bfe2d874ff687f593a146"
readonly AAHD_MATH_SHA256="6359763897e042c19daa8ec0f9a9f14c7b462332306b4cd9bd91b2d364904954"
readonly PTHREAD_PATCH_SHA256="$(sha256sum "$ROOT/scripts/patch-libraw-pthreads.mjs" | cut -d ' ' -f 1)"
readonly PARALLEL_FOR_SHA256="$(sha256sum "$ROOT/crates/lutify-libraw/src/parallel_for.h" | cut -d ' ' -f 1)"
readonly BROWSER_WRAPPER_SHA256="$(sha256sum "$ROOT/crates/lutify-libraw/src/browser_wrapper.cpp" | cut -d ' ' -f 1)"
readonly BUILD_ID="libraw-${LIBRAW_COMMIT}-wrapper-${BROWSER_WRAPPER_SHA256:0:12}-jpeg-${JPEG_COMMIT}-x3f-fma-${FMA_OVERRIDE_SHA256:0:12}-aahd-${AAHD_MATH_SHA256:0:12}-pthread-${PTHREAD_PATCH_SHA256:0:12}-${PARALLEL_FOR_SHA256:0:12}-emcc-5.0.7-signed-char-wrapv-no-contract"
readonly JPEG_BUILD_DIR="$OUTPUT_DIR/.libjpeg-build"
readonly AAHD_OBJECT="$OUTPUT_DIR/.aahd_demosaic.o"
readonly AAHD_PTHREAD_OBJECT="$OUTPUT_DIR/.aahd_demosaic_pthread.o"
readonly PATCHED_SOURCE_DIR="web/src/libraw/.patched-libraw"
readonly -a CONTAINER_RUN=(
  "${CONTAINER_RUNTIME:-docker}" run --rm
  --user "$(id -u):$(id -g)"
  --env HOME=/tmp
  -v "$ROOT:/workspace"
  -w /workspace
)

[[ "$(sha256sum "$ROOT/crates/lutify-libraw/src/postprocessing_utils.cpp" | cut -d ' ' -f 1)" == "$FMA_OVERRIDE_SHA256" ]] \
  || { echo "LibRaw FMA override hash does not match $FMA_OVERRIDE_SHA256" >&2; exit 1; }
[[ "$(sha256sum "$ROOT/crates/lutify-libraw/src/aahd_math_override.h" | cut -d ' ' -f 1)" == "$AAHD_MATH_SHA256" ]] \
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
  && [[ -f "$OUTPUT_DIR/libraw.wasm" ]] \
  && [[ -f "$THREAD_OUTPUT_DIR/libraw.js" ]] \
  && [[ -f "$THREAD_OUTPUT_DIR/libraw.wasm" ]]; then
  echo "LibRaw WASM is current ($BUILD_ID)."
  exit 0
fi

cd "$ROOT"
mkdir -p "$OUTPUT_DIR" "$THREAD_OUTPUT_DIR"
rm -rf "$JPEG_BUILD_DIR" "$PATCHED_SOURCE_DIR"
cp -a vendor/LibRaw "$PATCHED_SOURCE_DIR"
node scripts/patch-libraw-pthreads.mjs "$PATCHED_SOURCE_DIR"
mapfile -d '' SOURCES < <(
  find vendor/LibRaw/src -name '*.cpp' \
    ! -path '*/integration/*' \
    ! -name 'postprocessing_ph.cpp' \
    ! -name 'preprocessing_ph.cpp' \
    ! -name 'write_ph.cpp' \
    ! -path '*/demosaic/aahd_demosaic.cpp' \
    ! -path '*/postprocessing/postprocessing_utils.cpp' \
    -print0 | sort -z
)
mapfile -d '' PTHREAD_SOURCES < <(
  find "$PATCHED_SOURCE_DIR/src" -name '*.cpp' \
    ! -path '*/integration/*' \
    ! -name 'postprocessing_ph.cpp' \
    ! -name 'preprocessing_ph.cpp' \
    ! -name 'write_ph.cpp' \
    ! -path '*/demosaic/aahd_demosaic.cpp' \
    ! -path '*/postprocessing/postprocessing_utils.cpp' \
    -print0 | sort -z
)
"${CONTAINER_RUN[@]}" \
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

"${CONTAINER_RUN[@]}" \
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
    -DUSE_X3FTOOLS \
    -Ivendor/LibRaw \
    -Ivendor/LibRaw/src/demosaic \
    -Ivendor/libjpeg-turbo/src \
    -Iweb/src/libraw/.libjpeg-build \
    -include crates/lutify-libraw/src/aahd_math_override.h \
    -c vendor/LibRaw/src/demosaic/aahd_demosaic.cpp \
    -o web/src/libraw/.aahd_demosaic.o

"${CONTAINER_RUN[@]}" \
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
    -DUSE_X3FTOOLS \
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
    crates/lutify-libraw/src/postprocessing_utils.cpp \
    crates/lutify-libraw/src/browser_wrapper.cpp \
    web/src/libraw/.aahd_demosaic.o \
    web/src/libraw/.libjpeg-build/libjpeg.a \
    -o web/src/libraw/libraw.js

"${CONTAINER_RUN[@]}" \
  "$IMAGE" \
  em++ \
    -std=c++17 \
    -O3 \
    -pthread \
    -fsigned-char \
    -fwrapv \
    -ffp-contract=off \
    -DLIBRAW_NODLL \
    -DUSE_JPEG \
    -DUSE_JPEG8 \
    -DUSE_X3FTOOLS \
    -I"$PATCHED_SOURCE_DIR" \
    -Ivendor/libjpeg-turbo/src \
    -Iweb/src/libraw/.libjpeg-build \
    -include crates/lutify-libraw/src/parallel_for.h \
    -include crates/lutify-libraw/src/aahd_math_override.h \
    -c "$PATCHED_SOURCE_DIR/src/demosaic/aahd_demosaic.cpp" \
    -o web/src/libraw/.aahd_demosaic_pthread.o

"${CONTAINER_RUN[@]}" \
  "$IMAGE" \
  em++ \
    -std=c++17 \
    -O3 \
    -pthread \
    -fsigned-char \
    -fwrapv \
    -ffp-contract=off \
    -DLIBRAW_NODLL \
    -DUSE_JPEG \
    -DUSE_JPEG8 \
    -DUSE_X3FTOOLS \
    -I"$PATCHED_SOURCE_DIR" \
    -Ivendor/libjpeg-turbo/src \
    -Iweb/src/libraw/.libjpeg-build \
    -include crates/lutify-libraw/src/parallel_for.h \
    --bind \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sENVIRONMENT=worker \
    -sDISABLE_EXCEPTION_CATCHING=0 \
    -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=128MB \
    '-sPTHREAD_POOL_SIZE=Math.max(1, Math.min(3, navigator.hardwareConcurrency - 1))' \
    -sPTHREAD_POOL_SIZE_STRICT=2 \
    "${PTHREAD_SOURCES[@]}" \
    crates/lutify-libraw/src/postprocessing_utils.cpp \
    crates/lutify-libraw/src/browser_wrapper.cpp \
    web/src/libraw/.aahd_demosaic_pthread.o \
    web/src/libraw/.libjpeg-build/libjpeg.a \
    -o web/src/libraw/threaded/libraw.js

rm -rf "$JPEG_BUILD_DIR" "$AAHD_OBJECT" "$AAHD_PTHREAD_OBJECT" "$PATCHED_SOURCE_DIR"
printf '%s' "$BUILD_ID" > "$OUTPUT_DIR/.build-id"
echo "Built $BUILD_ID."
