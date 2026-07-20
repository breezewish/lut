# Processing Specification

## Input

The decoder accepts camera RAW bytes and either returns a three-channel RGB16 image or fails. Canonical settings are camera white balance, camera matrix enabled, AAHD, Blend highlight reconstruction, linear gamma, ProPhoto output, 16 bits, and no automatic brightening. `LibRaw ProPhoto D65 Linear` means the numerical output basis defined by pinned LibRaw's `prophoto_rgb` constant; it is not nominal ProPhoto primaries independently normalized to D65.

## Corrected-v2

Exposure multiplies linear RGB by `2^EV`. The shared computation API accepts finite EV in `[-12, 12]`. Relative white balance then applies a Bradford chromatic-adaptation matrix in linear ProPhoto D65. Temperature and Tint each accept finite values in `[-100, 100]`; zero on both axes is the exact As Shot identity. Temperature shifts the 6504 K anchor by one mired per step. Tint shifts the Planckian locus by `-0.0005 Duv` per step. The Base path converts ProPhoto D65 to linear sRGB, applies the hue-preserving luminance scale `1 / (1 + Y)`, clamps negative display values, and applies the sRGB transfer function.

The LUT path applies the fixed ProPhoto D65 to V-Gamut D65 matrix, Panasonic's piecewise V-Log formula including its negative-capable linear branch, lookup-domain clamping, and tetrahedral interpolation. Red is the fastest-changing CUBE axis. Camera-Match Boost is disabled.

Preview produces RGBA8. Export produces either an uncompressed interleaved RGB16 TIFF or an 8-bit JPEG at quality 95. Corrected RGB16 quantization clamps to `[0,1]`, scales by 65535, and rounds to nearest. JPEG input rounds each RGB16 code to the nearest RGB8 code before standard JPEG color conversion and compression.

## Browser automatic exposure

The browser derives one baseline EV from the display-sized linear RGB16 source before its first processed preview. It divides the image into a 7 × 7 matrix, meters luminance in the corrected linear-sRGB basis, emphasizes the center with a Gaussian weight, reduces zones above the zone p90, and slightly raises zones below the zone p10. The weighted scene luminance targets 18% gray. A max-RGB p99 histogram limits the exposed highlight to 6.0 linear, and gain is bounded to `[0.1, 100]`.

The user EV is a relative adjustment. Preview and export use `baseline EV + user EV`. The baseline is image-derived rather than copied from capture metadata, because shutter speed, aperture, and ISO describe acquisition but do not determine a useful output brightness after RAW normalization.

## LUT contract

Only the 27 pinned V-Log creative looks are supported. Files must contain exactly one finite 3D LUT with edge size 2 through 129, a valid domain, and the exact expected node count. Each file must match its manifest SHA-256.

The LUT input is verified as V-Gamut/V-Log with tetrahedral interpolation. Output gamut and transfer remain unverified because the CUBE files contain no such metadata.

## Failure behavior

Empty images, inconsistent dimensions, invalid exposure or white balance, malformed CUBE data, unsupported RAW files, non-finite values, and encoding failures are errors. No pipeline stage silently falls back or skips a failed LUT.
