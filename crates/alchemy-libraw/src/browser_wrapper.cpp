#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <new>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>

#include "libraw/libraw.h"

namespace {

using emscripten::typed_memory_view;
using emscripten::val;

struct DecodeTimings {
  double input_copy_ms = 0;
  double open_ms = 0;
  double unpack_ms = 0;
  double preprocess_ms = 0;
  double demosaic_ms = 0;
  double postprocess_ms = 0;
  double color_conversion_ms = 0;
  double preview_resize_ms = 0;
  double process_remainder_ms = 0;
  double rgb16_ms = 0;
  double total_ms = 0;
};

class TimedLibRaw final : public LibRaw {
public:
  TimedLibRaw() {
    // The production parameter set keeps med_passes at zero. LibRaw treats a
    // post-interpolate callback as the replacement for its optional median
    // filter, so this timing boundary must remain paired with that invariant.
    callbacks.pre_interpolate_cb = &TimedLibRaw::start_demosaic;
    callbacks.post_interpolate_cb = &TimedLibRaw::finish_demosaic;
    callbacks.pre_converttorgb_cb = &TimedLibRaw::start_color_conversion;
    callbacks.post_converttorgb_cb = &TimedLibRaw::finish_color_conversion;
  }

  void reset_process_timings() {
    process_started_at_ = emscripten_get_now();
    demosaic_started_at_ = demosaic_finished_at_ = 0;
    color_started_at_ = color_finished_at_ = 0;
  }

  void set_preview_max_edge(unsigned max_edge) {
    preview_max_edge_ = max_edge;
    preview_resize_ms_ = 0;
  }

  bool has_legacy_fuji_geometry() const {
    return libraw_internal_data.internal_output_params.fuji_width != 0;
  }

  void finish_process_timings(DecodeTimings &timings) const {
    const double finished_at = emscripten_get_now();
    if (demosaic_started_at_ != 0) {
      timings.preprocess_ms = demosaic_started_at_ - process_started_at_;
    }
    if (demosaic_finished_at_ != 0) {
      timings.demosaic_ms = demosaic_finished_at_ - demosaic_started_at_;
    }
    if (color_started_at_ != 0) {
      timings.postprocess_ms = color_started_at_ - demosaic_finished_at_;
    }
    if (color_finished_at_ != 0) {
      timings.color_conversion_ms = color_finished_at_ - color_started_at_;
      timings.process_remainder_ms = finished_at - color_finished_at_;
    }
    timings.preview_resize_ms = preview_resize_ms_;
  }

private:
  struct PreviewGeometry {
    unsigned source_width;
    unsigned source_height;
    unsigned output_width;
    unsigned output_height;
    unsigned target_output_width;
    unsigned target_output_height;
    unsigned target_width;
    unsigned target_height;
  };

  double process_started_at_ = 0;
  double demosaic_started_at_ = 0;
  double demosaic_finished_at_ = 0;
  double color_started_at_ = 0;
  double color_finished_at_ = 0;
  double preview_resize_ms_ = 0;
  unsigned preview_max_edge_ = 0;

  static std::size_t oriented_index(unsigned row, unsigned col,
                                    unsigned width, unsigned height,
                                    int flip) {
    if (flip & 4) {
      std::swap(row, col);
    }
    if (flip & 2) {
      row = height - 1 - row;
    }
    if (flip & 1) {
      col = width - 1 - col;
    }
    return static_cast<std::size_t>(row) * width + col;
  }

  bool preview_geometry(unsigned source_width, unsigned source_height, int flip,
                        PreviewGeometry &geometry) const {
    const bool transposed = (flip & 4) != 0;
    const unsigned output_width = transposed ? source_height : source_width;
    const unsigned output_height = transposed ? source_width : source_height;
    const unsigned longest_edge = std::max(output_width, output_height);
    if (longest_edge <= preview_max_edge_) {
      return false;
    }

    const double scale = static_cast<double>(preview_max_edge_) / longest_edge;
    const unsigned target_output_width =
        std::max(1U, static_cast<unsigned>(std::lround(output_width * scale)));
    const unsigned target_output_height =
        std::max(1U, static_cast<unsigned>(std::lround(output_height * scale)));
    geometry = {
        source_width,
        source_height,
        output_width,
        output_height,
        target_output_width,
        target_output_height,
        transposed ? target_output_height : target_output_width,
        transposed ? target_output_width : target_output_height,
    };
    return true;
  }

  void resize_preview() {
    if (preview_max_edge_ == 0 || imgdata.image == nullptr) {
      return;
    }

    auto &sizes = imgdata.sizes;
    // Legacy diagonal Fuji layouts and non-square pixels still require
    // LibRaw's later geometric resampling. Keep their exact path until a
    // display-sized implementation can perform those transforms directly.
    if (libraw_internal_data.internal_output_params.fuji_width != 0 ||
        std::abs(sizes.pixel_aspect - 1.0) > 0.005) {
      return;
    }

    PreviewGeometry geometry;
    if (!preview_geometry(sizes.width, sizes.height, sizes.flip, geometry)) {
      return;
    }

    const std::size_t pixel_count =
        static_cast<std::size_t>(geometry.target_width) *
        geometry.target_height;
    auto *target = static_cast<unsigned short(*)[4]>(
        std::calloc(pixel_count, sizeof(unsigned short[4])));
    if (target == nullptr) {
      throw std::bad_alloc();
    }

    for (unsigned row = 0; row < geometry.target_output_height; ++row) {
      const unsigned source_row = static_cast<unsigned>(
          static_cast<std::uint64_t>(row) * geometry.output_height /
          geometry.target_output_height);
      for (unsigned col = 0; col < geometry.target_output_width; ++col) {
        const unsigned source_col = static_cast<unsigned>(
            static_cast<std::uint64_t>(col) * geometry.output_width /
            geometry.target_output_width);
        const std::size_t source =
            oriented_index(source_row, source_col, geometry.source_width,
                           geometry.source_height, sizes.flip);
        const std::size_t destination =
            oriented_index(row, col, geometry.target_width,
                           geometry.target_height, sizes.flip);
        std::memcpy(target[destination], imgdata.image[source],
                    sizeof(*target));
      }
    }

    std::free(imgdata.image);
    imgdata.image = target;
    sizes.width = sizes.iwidth = geometry.target_width;
    sizes.height = sizes.iheight = geometry.target_height;
  }

  void copy_bayer(unsigned short cblack[4],
                  unsigned short *data_maximum) override {
    auto &sizes = imgdata.sizes;
    const auto &parameters = imgdata.params;
    const auto &identity = imgdata.idata;
    const auto &internal = libraw_internal_data.internal_output_params;
    if (preview_max_edge_ == 0 || !parameters.half_size ||
        internal.shrink != 1 || identity.filters <= 1000 ||
        internal.fuji_width != 0 ||
        std::abs(sizes.pixel_aspect - 1.0) > 0.005 ||
        imgdata.rawdata.raw_image == nullptr) {
      LibRaw::copy_bayer(cblack, data_maximum);
      return;
    }

    const double started_at = emscripten_get_now();
    PreviewGeometry geometry;
    if (!preview_geometry(sizes.iwidth, sizes.iheight, sizes.flip, geometry)) {
      LibRaw::copy_bayer(cblack, data_maximum);
      return;
    }

    const std::size_t target_pixels =
        static_cast<std::size_t>(geometry.target_width) *
        geometry.target_height;

    const unsigned available_height = sizes.raw_height > sizes.top_margin
                                          ? sizes.raw_height - sizes.top_margin
                                          : 0;
    const unsigned available_width = sizes.raw_width > sizes.left_margin
                                         ? sizes.raw_width - sizes.left_margin
                                         : 0;
    const unsigned copy_height =
        std::min<unsigned>(sizes.height, available_height);
    const unsigned copy_width =
        std::min<unsigned>(sizes.width, available_width);
    const unsigned raw_stride = sizes.raw_pitch / sizeof(unsigned short);
    // openPreview disables exposure-specific maximum adjustment, so the
    // caller does not consume this scan result. Export never enters this path.
    *data_maximum = 0;

    std::memset(imgdata.image, 0, target_pixels * sizeof(*imgdata.image));
    for (unsigned row = 0; row < geometry.target_output_height; ++row) {
      const unsigned source_output_row = static_cast<unsigned>(
          static_cast<std::uint64_t>(row) * geometry.output_height /
          geometry.target_output_height);
      for (unsigned col = 0; col < geometry.target_output_width; ++col) {
        const unsigned source_output_col = static_cast<unsigned>(
            static_cast<std::uint64_t>(col) * geometry.output_width /
            geometry.target_output_width);
        const std::size_t source_index = oriented_index(
            source_output_row, source_output_col, geometry.source_width,
            geometry.source_height, sizes.flip);
        const unsigned source_row = source_index / geometry.source_width;
        const unsigned source_col = source_index % geometry.source_width;
        const std::size_t destination =
            oriented_index(row, col, geometry.target_width,
                           geometry.target_height, sizes.flip);

        for (unsigned raw_row = source_row * 2;
             raw_row < std::min(copy_height, source_row * 2 + 2); ++raw_row) {
          const auto *source =
              imgdata.rawdata.raw_image +
              static_cast<std::size_t>(raw_row + sizes.top_margin) *
                  raw_stride +
              sizes.left_margin;
          for (unsigned raw_col = source_col * 2;
               raw_col < std::min(copy_width, source_col * 2 + 2); ++raw_col) {
            const int channel = fcol(raw_row, raw_col);
            const unsigned short value = source[raw_col];
            imgdata.image[destination][channel] =
                value > cblack[channel] ? value - cblack[channel] : 0;
          }
        }
      }
    }

    void *resized =
        realloc(imgdata.image, target_pixels * sizeof(*imgdata.image));
    if (resized == nullptr) {
      throw std::bad_alloc();
    }
    imgdata.image = static_cast<unsigned short(*)[4]>(resized);
    sizes.iwidth = geometry.target_width;
    sizes.iheight = geometry.target_height;
    preview_resize_ms_ += emscripten_get_now() - started_at;
  }

  static void start_demosaic(void *raw) {
    auto *processor = static_cast<TimedLibRaw *>(raw);
    processor->demosaic_started_at_ = emscripten_get_now();
    if (processor->preview_max_edge_ == 0) {
      return;
    }
    const double resize_started_at = emscripten_get_now();
    processor->resize_preview();
    processor->preview_resize_ms_ += emscripten_get_now() - resize_started_at;
  }

  static void finish_demosaic(void *raw) {
    static_cast<TimedLibRaw *>(raw)->demosaic_finished_at_ = emscripten_get_now();
  }

  static void start_color_conversion(void *raw) {
    static_cast<TimedLibRaw *>(raw)->color_started_at_ = emscripten_get_now();
  }

  static void finish_color_conversion(void *raw) {
    static_cast<TimedLibRaw *>(raw)->color_finished_at_ = emscripten_get_now();
  }
};

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
    open_with_quality_and_preview(bytes, half_size, 12, 0);
  }

  void open_with_quality(const val &bytes, bool half_size, int quality) {
    open_with_quality_and_preview(bytes, half_size, quality, 0);
  }

  void open_preview(const val &bytes, unsigned max_edge) {
    if (max_edge == 0) {
      throw std::runtime_error("Preview longest edge must be positive");
    }
    open_with_quality_and_preview(bytes, true, 12, max_edge);
  }

  void open_with_quality_and_preview(const val &bytes, bool half_size,
                                     int quality, unsigned preview_max_edge) {
    if (quality != 3 && quality != 4 && quality != 12) {
      throw std::runtime_error(
          "LibRaw quality must be AHD (3), DCB (4), or AAHD (12)");
    }
    clear_image();
    processor_.recycle();
    timings_ = {};
    quality_ = quality;
    total_started_at_ = emscripten_get_now();
    processor_.set_preview_max_edge(preview_max_edge);
    const double copy_started_at = emscripten_get_now();
    input_ = copy_bytes(bytes);
    timings_.input_copy_ms = emscripten_get_now() - copy_started_at;

    auto &params = processor_.imgdata.params;
    params.half_size = half_size;
    params.use_camera_wb = 1;
    params.use_camera_matrix = 1;
    params.output_color = 4; // LibRaw's numerical ProPhoto D65 basis.
    params.output_bps = 16;
    params.no_auto_bright = 1;
    if (preview_max_edge != 0) {
      // Preview uses the camera white level. Scanning every sensor sample only
      // to lower that level for this particular exposure costs more than the
      // display-sized CFA construction itself and is not part of export.
      params.adjust_maximum_thr = 0;
    }
    params.highlight = 2; // Blend.
    params.med_passes = 0; // Required by the phase callback contract above.
    params.gamm[0] = 1.0;
    params.gamm[1] = 1.0;
    params.user_qual = quality;

    const double open_started_at = emscripten_get_now();
    const int status = processor_.open_buffer(input_.data(), input_.size());
    timings_.open_ms = emscripten_get_now() - open_started_at;
    if (status != LIBRAW_SUCCESS) {
      release_decoder_state();
      fail("open", status);
    }
    opened_ = true;
    if (preview_max_edge != 0 && processor_.has_legacy_fuji_geometry()) {
      release_decoder_state();
      throw std::runtime_error(
          "This legacy Fujifilm sensor layout cannot be previewed reliably");
    }
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
      const double unpack_started_at = emscripten_get_now();
      int status = processor_.unpack();
      timings_.unpack_ms = emscripten_get_now() - unpack_started_at;
      if (status == LIBRAW_SUCCESS) {
        processor_.reset_process_timings();
        status = processor_.dcraw_process();
        processor_.finish_process_timings(timings_);
      }
      if (status != LIBRAW_SUCCESS) {
        release_decoder_state();
        fail("decode", status);
      }

      int memory_status = LIBRAW_SUCCESS;
      const double rgb16_started_at = emscripten_get_now();
      image_ = processor_.dcraw_make_mem_image(&memory_status);
      timings_.rgb16_ms = emscripten_get_now() - rgb16_started_at;
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
      timings_.total_ms = emscripten_get_now() - total_started_at_;
    }

    val result = val::object();
    result.set("width", image_->width);
    result.set("height", image_->height);
    result.set("sampleCount", image_->data_size / sizeof(std::uint16_t));
    return result;
  }

  val timings() const {
    if (image_ == nullptr) {
      throw std::runtime_error("LibRaw image_info() must be called first");
    }
    val result = val::object();
    result.set("quality", quality_);
    result.set("inputCopyMs", timings_.input_copy_ms);
    result.set("openMs", timings_.open_ms);
    result.set("unpackMs", timings_.unpack_ms);
    result.set("preprocessMs", timings_.preprocess_ms);
    result.set("demosaicMs", timings_.demosaic_ms);
    result.set("postprocessMs", timings_.postprocess_ms);
    result.set("colorConversionMs", timings_.color_conversion_ms);
    result.set("previewResizeMs", timings_.preview_resize_ms);
    result.set("processRemainderMs", timings_.process_remainder_ms);
    result.set("rgb16Ms", timings_.rgb16_ms);
    result.set("totalMs", timings_.total_ms);
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
  TimedLibRaw processor_;
  std::vector<std::uint8_t> input_;
  libraw_processed_image_t *image_ = nullptr;
  bool opened_ = false;
  int quality_ = 12;
  double total_started_at_ = 0;
  DecodeTimings timings_;

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
      .function("openPreview", &BrowserLibRaw::open_preview)
      .function("openWithQuality", &BrowserLibRaw::open_with_quality)
      .function("metadata", &BrowserLibRaw::metadata)
      .function("thumbnailData", &BrowserLibRaw::thumbnail_data)
      .function("imageInfo", &BrowserLibRaw::image_info)
      .function("timings", &BrowserLibRaw::timings)
      .function("imageView", &BrowserLibRaw::image_view);
}
