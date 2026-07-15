#ifndef RAW_ALCHEMY_H
#define RAW_ALCHEMY_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum AlchemyStatus {
  ALCHEMY_OK = 0,
  ALCHEMY_INVALID_ARGUMENT = 1,
  ALCHEMY_INVALID_CUBE = 2,
  ALCHEMY_INVALID_IMAGE = 3,
  ALCHEMY_INVALID_EXPOSURE = 4,
  ALCHEMY_ENCODING_FAILED = 5,
} AlchemyStatus;

typedef struct AlchemyBuffer {
  uint8_t *data;
  size_t len;
  size_t capacity;
} AlchemyBuffer;

typedef struct AlchemyRenderResult {
  AlchemyStatus status;
  AlchemyBuffer buffer;
} AlchemyRenderResult;

float alchemy_encode_v_log(float linear);

AlchemyRenderResult alchemy_render_tiff_v2(const uint16_t *pixels,
                                            size_t pixel_len, uint32_t width,
                                            uint32_t height, float ev,
                                            const uint8_t *cube,
                                            size_t cube_len);

void alchemy_free_buffer(AlchemyBuffer buffer);

const char *alchemy_status_message(int status);

#ifdef __cplusplus
}
#endif

#endif
