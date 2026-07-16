#pragma once

#include "../../../vendor/LibRaw/internal/dmp_include.h"

// LibRaw builds AAHD's transfer-function table from pow(float, float). The
// native and WebAssembly C libraries round a few entries differently. Promote
// that one call to double precision so both runtimes generate the same table.
// AAHD's other pow call already uses double arguments and remains unchanged.
inline double alchemy_aahd_pow(float base, float exponent) {
  return ::pow(static_cast<double>(base), static_cast<double>(exponent));
}

inline double alchemy_aahd_pow(double base, double exponent) {
  return ::pow(base, exponent);
}

#define pow(base, exponent) alchemy_aahd_pow(base, exponent)
