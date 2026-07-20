#ifndef LUTIFY_H
#define LUTIFY_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum LutifyStatus {
  LUTIFY_OK = 0,
  LUTIFY_INVALID_ARGUMENT = 1,
  LUTIFY_INVALID_CUBE = 2,
  LUTIFY_INVALID_IMAGE = 3,
  LUTIFY_INVALID_EXPOSURE = 4,
  LUTIFY_ENCODING_FAILED = 5,
} LutifyStatus;

typedef struct LutifyBuffer {
  uint8_t *data;
  size_t len;
  size_t capacity;
} LutifyBuffer;

typedef struct LutifyRenderResult {
  LutifyStatus status;
  LutifyBuffer buffer;
} LutifyRenderResult;

/* Encodes one linear V-Gamut value with Panasonic's piecewise V-Log curve. */
float lutify_encode_v_log(float linear);

/*
 * Renders one corrected-v2 16-bit RGB TIFF.
 *
 * pixels contains width * height * 3 interleaved RGB16 samples in the pinned
 * LibRaw ProPhoto D65 Linear basis. ev must be finite and within [-12, 12].
 * cube contains one UTF-8 3D CUBE document.
 * On success, the caller owns result.buffer and must release it exactly once
 * with lutify_free_buffer. On failure, result.buffer is all zeroes.
 */
LutifyRenderResult lutify_render_tiff_v2(const uint16_t *pixels,
                                          size_t pixel_len, uint32_t width,
                                          uint32_t height, float ev,
                                          const uint8_t *cube,
                                          size_t cube_len);

/* Releases an unchanged, non-null buffer returned by lutify_render_tiff_v2. */
void lutify_free_buffer(LutifyBuffer buffer);

/* Returns a process-lifetime English description for a stable status code. */
const char *lutify_status_message(int status);

#ifdef __cplusplus
}
#endif

#endif
