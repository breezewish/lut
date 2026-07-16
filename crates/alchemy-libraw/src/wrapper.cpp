#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "libraw/libraw.h"

extern "C" {

struct AlchemyDecodedImage {
  std::uint32_t width;
  std::uint32_t height;
  std::uint16_t *pixels;
  std::size_t pixel_count;
  char error[256];
};

int alchemy_libraw_decode(const std::uint8_t *bytes, std::size_t length,
                          bool half_size, AlchemyDecodedImage *output) {
  std::memset(output, 0, sizeof(*output));
  LibRaw processor;
  processor.imgdata.params.half_size = half_size;
  processor.imgdata.params.use_camera_wb = 1;
  processor.imgdata.params.use_camera_matrix = 1;
  processor.imgdata.params.output_color =
      4; // LibRaw's numerical ProPhoto D65 basis.
  processor.imgdata.params.output_bps = 16;
  processor.imgdata.params.no_auto_bright = 1;
  processor.imgdata.params.highlight = 2; // Match Raw Alchemy's Blend mode.
  processor.imgdata.params.gamm[0] = 1.0;
  processor.imgdata.params.gamm[1] = 1.0;
  processor.imgdata.params.user_qual = 12; // AAHD.

  int status = processor.open_buffer(bytes, length);
  if (status == LIBRAW_SUCCESS) {
    status = processor.unpack();
  }
  if (status == LIBRAW_SUCCESS) {
    status = processor.dcraw_process();
  }
  if (status != LIBRAW_SUCCESS) {
    std::snprintf(output->error, sizeof(output->error), "LibRaw: %s",
                  libraw_strerror(status));
    return status;
  }

  int memory_status = LIBRAW_SUCCESS;
  libraw_processed_image_t *image =
      processor.dcraw_make_mem_image(&memory_status);
  if (!image || memory_status != LIBRAW_SUCCESS) {
    std::snprintf(output->error, sizeof(output->error),
                  "LibRaw could not create the processed image: %s",
                  libraw_strerror(memory_status));
    if (image) {
      LibRaw::dcraw_clear_mem(image);
    }
    return memory_status == LIBRAW_SUCCESS ? LIBRAW_UNSPECIFIED_ERROR
                                           : memory_status;
  }

  if (image->type != LIBRAW_IMAGE_BITMAP || image->bits != 16 ||
      image->colors != 3 || image->data_size % sizeof(std::uint16_t) != 0) {
    std::snprintf(output->error, sizeof(output->error),
                  "LibRaw returned an unexpected image layout");
    LibRaw::dcraw_clear_mem(image);
    return LIBRAW_UNSPECIFIED_ERROR;
  }

  output->width = image->width;
  output->height = image->height;
  output->pixel_count = image->data_size / sizeof(std::uint16_t);
  output->pixels = static_cast<std::uint16_t *>(std::malloc(image->data_size));
  if (!output->pixels) {
    std::snprintf(output->error, sizeof(output->error),
                  "Could not allocate decoded image memory");
    LibRaw::dcraw_clear_mem(image);
    return LIBRAW_UNSUFFICIENT_MEMORY;
  }
  std::memcpy(output->pixels, image->data, image->data_size);
  LibRaw::dcraw_clear_mem(image);
  return LIBRAW_SUCCESS;
}

void alchemy_libraw_free(std::uint16_t *pixels) { std::free(pixels); }

const char *alchemy_libraw_version() { return LibRaw::version(); }
}
