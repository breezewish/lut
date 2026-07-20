#include <stdint.h>
#include <string.h>

#include "lutify.h"

int main(void) {
  static const char cube[] = "LUT_3D_SIZE 2\n"
                             "0 0 0\n1 0 0\n0 1 0\n1 1 0\n"
                             "0 0 1\n1 0 1\n0 1 1\n1 1 1\n";
  const uint16_t pixels[] = {0, 32768, 65535};

  if (strcmp(lutify_status_message(LUTIFY_OK), "ok") != 0) {
    return 1;
  }

  const LutifyRenderResult result = lutify_render_tiff_v2(
      pixels, 3, 1, 1, 0.0f, 0.0f, 0.0f, (const uint8_t *)cube, strlen(cube));
  if (result.status != LUTIFY_OK || result.buffer.data == NULL ||
      result.buffer.len < 8) {
    return 2;
  }
  lutify_free_buffer(result.buffer);
  return 0;
}
