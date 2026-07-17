#!/usr/bin/env bash

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"
npx playwright install chromium
npm run build
cargo build --quiet --release -p alchemy-cli
node scripts/prepare-webgpu-camera-fixtures.mjs

WEBGPU_HARDWARE=1 \
WEBGPU_PREVIEW=1 \
RAW_PERF=1 \
AAHD_EXPORT_E2E=1 \
AAHD_EXPORT_MATRIX_E2E=1 \
WEBGPU_CAMERA_MATRIX_E2E=1 \
PLAYWRIGHT_HTTP_PORT=46731 \
npx playwright test \
  web/e2e/webgpu-preview.spec.ts \
  web/e2e/aahd-export.spec.ts \
  web/e2e/aahd-camera-matrix.spec.ts \
  web/e2e/preview-interaction-performance.spec.ts \
  web/e2e/raw-compat.spec.ts \
  web/e2e/raw-performance.spec.ts \
  --project=chromium

VITE_ENABLE_TEST_ENTRIES=1 npm run bundle:test
AAHD_TILE_E2E=1 \
WEBGPU_HARDWARE=1 \
PLAYWRIGHT_HTTP_PORT=46731 \
npx playwright test web/e2e/aahd-tile.spec.ts --project=chromium
