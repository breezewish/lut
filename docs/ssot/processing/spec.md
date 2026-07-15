# Processing Specification

## Input

The decoder accepts camera RAW bytes and either returns a three-channel RGB16 image or fails. Canonical settings are camera white balance, camera matrix enabled, AAHD, Blend highlight reconstruction, linear gamma, ProPhoto output, 16 bits, and no automatic brightening. `LibRaw ProPhoto D65 Linear` means the numerical output basis defined by pinned LibRaw's `prophoto_rgb` constant; it is not nominal ProPhoto primaries independently normalized to D65.

## Corrected-v2

Exposure multiplies linear RGB by `2^EV`. The Base path converts ProPhoto D65 to linear sRGB, applies one luminance-only shoulder, clamps negative display values, and applies the sRGB transfer function.

The LUT path applies the fixed ProPhoto D65 to V-Gamut D65 matrix, Panasonic's piecewise V-Log formula including its negative-capable linear branch, lookup-domain clamping, and tetrahedral interpolation. Red is the fastest-changing CUBE axis. Camera-Match Boost is disabled.

Preview produces RGBA8. Export produces a Deflate-compressed interleaved RGB16 TIFF. Corrected quantization clamps to `[0,1]`, scales by 65535, and rounds to nearest.

## LUT contract

Only the 27 pinned V-Log creative looks are supported. Files must contain exactly one finite 3D LUT with edge size 2 through 129, a valid domain, and the exact expected node count. Each file must match its manifest SHA-256.

The LUT input is verified as V-Gamut/V-Log with tetrahedral interpolation. Output gamut and transfer remain unverified because the CUBE files contain no such metadata.

## Failure behavior

Empty images, inconsistent dimensions, invalid exposure, malformed CUBE data, unsupported RAW files, non-finite values, and encoding failures are errors. No pipeline stage silently falls back or skips a failed LUT.
