#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <emscripten/bind.h>

#include "libraw/libraw.h"

namespace {

using emscripten::typed_memory_view;
using emscripten::val;

class BrowserLibRaw {
public:
  BrowserLibRaw() = default;

  ~BrowserLibRaw() {
    clear_image();
    processor_.recycle();
  }

  BrowserLibRaw(const BrowserLibRaw &) = delete;
  BrowserLibRaw &operator=(const BrowserLibRaw &) = delete;

  void open(const val &bytes, bool half_size) {
    clear_image();
    processor_.recycle();
    input_ = copy_bytes(bytes);

    auto &params = processor_.imgdata.params;
    params.half_size = half_size;
    params.use_camera_wb = 1;
    params.use_camera_matrix = 1;
    params.output_color = 4; // LibRaw's numerical ProPhoto D65 basis.
    params.output_bps = 16;
    params.no_auto_bright = 1;
    params.highlight = 2; // Blend.
    params.gamm[0] = 1.0;
    params.gamm[1] = 1.0;
    params.user_qual = 12; // AAHD.

    const int status = processor_.open_buffer(input_.data(), input_.size());
    if (status != LIBRAW_SUCCESS) {
      release_decoder_state();
      fail("open", status);
    }
    opened_ = true;
  }

  val metadata() const {
    require_opened();
    val result = val::object();
    unsigned width = processor_.imgdata.sizes.width;
    unsigned height = processor_.imgdata.sizes.height;
    const int flip = processor_.imgdata.sizes.flip;
    if (flip == 5 || flip == 6 || flip == 7) {
      std::swap(width, height);
    }
    result.set("width", width);
    result.set("height", height);
    result.set("camera_make", std::string(processor_.imgdata.idata.make));
    result.set("camera_model", std::string(processor_.imgdata.idata.model));
    return result;
  }

  val thumbnail_data() {
    require_opened();
    if (processor_.unpack_thumb() != LIBRAW_SUCCESS) {
      return val::undefined();
    }
    libraw_processed_image_t *thumbnail = processor_.dcraw_make_mem_thumb();
    if (thumbnail == nullptr) {
      return val::undefined();
    }

    val result = val::object();
    const val bytes = val::global("Uint8Array").new_(thumbnail->data_size);
    bytes.call<void>(
        "set", val(typed_memory_view(thumbnail->data_size, thumbnail->data)));
    result.set("data", bytes);
    result.set("width", thumbnail->width != 0
                            ? thumbnail->width
                            : processor_.imgdata.thumbnail.twidth);
    result.set("height", thumbnail->height != 0
                             ? thumbnail->height
                             : processor_.imgdata.thumbnail.theight);
    result.set("format", thumbnail->type == LIBRAW_IMAGE_JPEG     ? "jpeg"
                         : thumbnail->type == LIBRAW_IMAGE_BITMAP ? "bitmap"
                                                                  : "unknown");
    LibRaw::dcraw_clear_mem(thumbnail);
    return result;
  }

  val image_info() {
    if (image_ == nullptr) {
      require_opened();
      int status = processor_.unpack();
      if (status == LIBRAW_SUCCESS) {
        status = processor_.dcraw_process();
      }
      if (status != LIBRAW_SUCCESS) {
        release_decoder_state();
        fail("decode", status);
      }

      int memory_status = LIBRAW_SUCCESS;
      image_ = processor_.dcraw_make_mem_image(&memory_status);
      if (image_ == nullptr || memory_status != LIBRAW_SUCCESS) {
        clear_image();
        release_decoder_state();
        fail("create the processed image", memory_status == LIBRAW_SUCCESS
                                               ? LIBRAW_UNSPECIFIED_ERROR
                                               : memory_status);
      }
      if (image_->type != LIBRAW_IMAGE_BITMAP || image_->bits != 16 ||
          image_->colors != 3 ||
          image_->data_size % sizeof(std::uint16_t) != 0) {
        clear_image();
        release_decoder_state();
        throw std::runtime_error(
            "LibRaw returned an unexpected processed image layout");
      }

      // dcraw_make_mem_image owns an independent copy. Release the input RAW,
      // mosaic, and four-channel processing state before color rendering. The
      // remaining RGB16 allocation is read through bounded zero-copy views.
      release_decoder_state();
    }

    val result = val::object();
    result.set("width", image_->width);
    result.set("height", image_->height);
    result.set("sampleCount", image_->data_size / sizeof(std::uint16_t));
    return result;
  }

  val image_view(std::size_t offset, std::size_t length) const {
    if (image_ == nullptr) {
      throw std::runtime_error("LibRaw image_info() must be called first");
    }
    const std::size_t sample_count = image_->data_size / sizeof(std::uint16_t);
    if (offset > sample_count || length > sample_count - offset) {
      throw std::runtime_error("LibRaw RGB16 view exceeds the decoded image");
    }
    const auto *pixels = reinterpret_cast<const std::uint16_t *>(image_->data);
    return val(typed_memory_view(length, pixels + offset));
  }

private:
  LibRaw processor_;
  std::vector<std::uint8_t> input_;
  libraw_processed_image_t *image_ = nullptr;
  bool opened_ = false;

  static std::vector<std::uint8_t> copy_bytes(const val &source) {
    const val uint8_array = val::global("Uint8Array");
    if (!source.instanceof(uint8_array)) {
      throw std::runtime_error("LibRaw input must be a Uint8Array");
    }
    const std::size_t length = source["byteLength"].as<std::size_t>();
    std::vector<std::uint8_t> result(length);
    val(typed_memory_view(result.size(), result.data()))
        .call<void>("set", source);
    return result;
  }

  void require_opened() const {
    if (!opened_) {
      throw std::runtime_error("LibRaw has no open RAW file");
    }
  }

  void clear_image() {
    if (image_ != nullptr) {
      LibRaw::dcraw_clear_mem(image_);
      image_ = nullptr;
    }
  }

  void release_decoder_state() {
    processor_.recycle();
    std::vector<std::uint8_t>().swap(input_);
    opened_ = false;
  }

  [[noreturn]] static void fail(const char *operation, int status) {
    throw std::runtime_error(std::string("LibRaw could not ") + operation +
                             ": " + LibRaw::strerror(status));
  }
};

} // namespace

EMSCRIPTEN_BINDINGS(raw_alchemy_libraw) {
  emscripten::class_<BrowserLibRaw>("LibRaw")
      .constructor<>()
      .function("open", &BrowserLibRaw::open)
      .function("metadata", &BrowserLibRaw::metadata)
      .function("thumbnailData", &BrowserLibRaw::thumbnail_data)
      .function("imageInfo", &BrowserLibRaw::image_info)
      .function("imageView", &BrowserLibRaw::image_view);
}
