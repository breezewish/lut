#include <algorithm>
#include <array>
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

constexpr char NIKON_HIGH_EFFICIENCY_RAW_ERROR[] =
    "LUTIFY_UNSUPPORTED_NIKON_HIGH_EFFICIENCY_RAW";
constexpr char GOPRO_GPR_ERROR[] = "LUTIFY_UNSUPPORTED_GOPRO_GPR";
constexpr char JPEG_XL_DNG_ERROR[] = "LUTIFY_UNSUPPORTED_JPEG_XL_DNG";

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

struct SensorTimings {
  double input_copy_ms = 0;
  double open_ms = 0;
  double unpack_ms = 0;
  double mosaic_copy_ms = 0;
  double total_ms = 0;
};

class SpatialBlackLevelsUnsupported final : public std::runtime_error {
public:
  SpatialBlackLevelsUnsupported()
      : std::runtime_error(
            "Spatially varying RAW black levels are not supported") {}
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

  void enable_demosaic_capture() {
    capture_demosaic_ = true;
    demosaic_capture_.clear();
  }

  const std::vector<std::uint16_t> &demosaic_capture() const {
    return demosaic_capture_;
  }

  bool has_legacy_fuji_geometry() const {
    return libraw_internal_data.internal_output_params.fuji_width != 0;
  }

  bool has_parallel_packed_dng() const {
    const unsigned bits = libraw_internal_data.unpacker_data.tiff_bps;
    return imgdata.idata.filters != 0 &&
           libraw_internal_data.unpacker_data.tiff_samples == 1 && bits >= 8 &&
           bits <= 15;
  }

  bool has_standard_aahd_geometry() {
    const auto &sizes = imgdata.sizes;
    const auto &identity = imgdata.idata;
    const auto &internal = libraw_internal_data.internal_output_params;
    if (identity.colors != 3 || identity.filters <= 1000 ||
        identity.is_foveon || internal.zero_is_bad ||
        internal.fuji_width != 0 || imgdata.params.four_color_rgb ||
        std::abs(sizes.pixel_aspect - 1.0) > 0.005) {
      return false;
    }

    // Mirror pre_interpolate() before applying dcraw_process()'s AAHD gate.
    // Standard three-color Bayer merges its second green channel in the CFA
    // bit mask. LibRaw falls back to VNG when the resulting pattern contains
    // another color or equal horizontal/vertical neighbors.
    unsigned filters = identity.filters;
    filters &= ~((filters & 0x55555555U) << 1);
    const auto color = [filters](int row, int col) {
      return (filters >> (((row << 1 & 14) | (col & 1)) << 1)) & 3;
    };
    unsigned real_colors = identity.colors;
    unsigned bad_bayer = 0;
    for (int row = 0; row < 4; ++row) {
      for (int col = 0; col < 8; ++col) {
        real_colors = std::max(real_colors, color(row, col) + 1);
        bad_bayer += color(row, col) == color(row + 1, col);
        bad_bayer += color(row, col) == color(row, col + 1);
      }
    }
    return real_colors == 3 && bad_bayer == 0;
  }

  bool has_standard_xtrans_geometry() const {
    const auto &sizes = imgdata.sizes;
    const auto &identity = imgdata.idata;
    const auto &internal = libraw_internal_data.internal_output_params;
    return identity.colors == 3 && identity.filters == LIBRAW_XTRANS &&
           !identity.is_foveon && !internal.zero_is_bad &&
           internal.fuji_width == 0 && !imgdata.params.four_color_rgb &&
           std::abs(sizes.pixel_aspect - 1.0) <= 0.005;
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
  bool capture_demosaic_ = false;
  std::vector<std::uint16_t> demosaic_capture_;

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
    if (processor->preview_max_edge_ != 0) {
      const double resize_started_at = emscripten_get_now();
      processor->resize_preview();
      processor->preview_resize_ms_ += emscripten_get_now() - resize_started_at;
    }
  }

  static void finish_demosaic(void *raw) {
    auto *processor = static_cast<TimedLibRaw *>(raw);
    if (processor->capture_demosaic_) {
      const std::size_t pixels =
          static_cast<std::size_t>(processor->imgdata.sizes.width) *
          processor->imgdata.sizes.height;
      processor->demosaic_capture_.resize(pixels * 3);
      for (std::size_t index = 0; index < pixels; ++index) {
        for (unsigned channel = 0; channel < 3; ++channel) {
          processor->demosaic_capture_[index * 3 + channel] =
              processor->imgdata.image[index][channel];
        }
      }
    }
    processor->demosaic_finished_at_ = emscripten_get_now();
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
    sensor_.clear();
    sensor_metadata_ = val::undefined();
    sensor_black_captured_ = false;
    processor_.recycle();
    timings_ = {};
    sensor_timings_ = {};
    unpacked_ = false;
    quality_ = quality;
    half_size_ = half_size;
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
    if (const char *unsupported = unsupported_decoder_error()) {
      release_decoder_state();
      throw std::runtime_error(unsupported);
    }
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

  val xtrans_cbrt_view() const {
    static const std::array<float, 65536> table = [] {
      std::array<float, 65536> values{};
      for (unsigned index = 0; index < values.size(); ++index) {
        const float ratio = index / 65535.0f;
        values[index] = ratio > 0.008856f
                            ? std::pow(ratio, 1.f / 3.0f)
                            : 7.787f * ratio + 16.f / 116.0f;
      }
      return values;
    }();
    return val(typed_memory_view(table.size(), table.data()));
  }

  bool uses_parallel_unpack() {
    require_opened();
    libraw_decoder_info_t decoder{};
    processor_.get_decoder_info(&decoder);
    if (decoder.decoder_name == nullptr) return false;
    if (std::strcmp(decoder.decoder_name, "fuji_compressed_load_raw()") == 0 ||
        std::strcmp(decoder.decoder_name, "panasonicC8_load_raw()") == 0 ||
        std::strcmp(decoder.decoder_name, "crxLoadRaw()") == 0 ||
        std::strcmp(decoder.decoder_name, "sony_arw2_load_raw()") == 0) {
      return true;
    }

    // Packed DNG is only expensive when LibRaw's generic getbits() extraction
    // is required. Tiny generated fixtures must not pay the lazy pthread
    // runtime startup cost.
    const auto pixels =
        static_cast<std::size_t>(processor_.imgdata.sizes.raw_width) *
        processor_.imgdata.sizes.raw_height;
    return std::strcmp(decoder.decoder_name, "packed_dng_load_raw()") == 0 &&
           pixels >= 1'000'000 && processor_.has_parallel_packed_dng();
  }

  val image_info() { return prepare_image_info(true); }

  val image_info_retaining_decoder() { return prepare_image_info(false); }

  val prepare_image_info(bool release_after_decode) {
    if (image_ == nullptr) {
      require_opened();
      int status = ensure_unpacked();
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

      // dcraw_make_mem_image owns an independent copy. Production normally
      // releases the larger decoder state here. Preview may retain it briefly
      // so the settled frame can publish before analyzing its copied mosaic.
      if (release_after_decode) release_decoder_state();
      timings_.total_ms = emscripten_get_now() - total_started_at_;
    }

    val result = val::object();
    result.set("width", image_->width);
    result.set("height", image_->height);
    result.set("sampleCount", image_->data_size / sizeof(std::uint16_t));
    return result;
  }

  void discard_image() { clear_image(); }

  void enable_demosaic_capture() { processor_.enable_demosaic_capture(); }

  val demosaic_view(std::size_t offset, std::size_t length) const {
    const auto &capture = processor_.demosaic_capture();
    if (capture.empty()) {
      throw std::runtime_error(
          "LibRaw demosaic capture must be enabled before image_info()");
    }
    if (offset > capture.size() || length > capture.size() - offset) {
      throw std::runtime_error("LibRaw demosaic view exceeds the captured image");
    }
    return val(typed_memory_view(length, capture.data() + offset));
  }

  bool supports_webgpu_aahd() {
    require_opened();
    const int status = ensure_unpacked();
    if (status != LIBRAW_SUCCESS) {
      release_decoder_state();
      fail("unpack the sensor mosaic", status);
    }

    const auto &sizes = processor_.imgdata.sizes;
    if (processor_.imgdata.rawdata.raw_image == nullptr ||
        !processor_.has_standard_aahd_geometry() || sizes.flip != 0 ||
        sizes.width == 0 ||
        sizes.height == 0 || sizes.width % 2 != 0 || sizes.height % 2 != 0) {
      return false;
    }
    try {
      adjusted_black_levels();
    } catch (const SpatialBlackLevelsUnsupported &) {
      return false;
    }
    return true;
  }

  bool supports_webgpu_xtrans() {
    require_opened();
    const int status = ensure_unpacked();
    if (status != LIBRAW_SUCCESS) {
      release_decoder_state();
      fail("unpack the sensor mosaic", status);
    }

    const auto &sizes = processor_.imgdata.sizes;
    if (processor_.imgdata.rawdata.raw_image == nullptr ||
        !processor_.has_standard_xtrans_geometry() || sizes.flip != 0 ||
        sizes.width < LIBRAW_AHD_TILE || sizes.height < LIBRAW_AHD_TILE) {
      return false;
    }
    try {
      adjusted_black_levels();
    } catch (const SpatialBlackLevelsUnsupported &) {
      return false;
    }
    return true;
  }

  val sensor_info() {
    val result = prepare_sensor_info(false);
    release_decoder_state();
    return result;
  }

  val finish_sensor_info() {
    val result = prepare_sensor_info(true);
    release_decoder_state();
    return result;
  }

  val prepare_sensor_info(bool opened_for_preview) {
    require_opened();
    capture_sensor_mosaic();
    if (sensor_metadata_.isUndefined()) {
      const auto &color = processor_.imgdata.rawdata.color;
      if (!sensor_black_captured_) {
        throw std::runtime_error(
            "LibRaw sensor black levels were not captured before processing");
      }
      const AdjustedBlackLevels black{sensor_black_channels_,
                                      sensor_black_common_};
      unsigned data_maximum = 0;
      for (unsigned row = 0; row < sensor_height_; ++row) {
        const auto *source =
            sensor_.data() + static_cast<std::size_t>(row) * sensor_width_;
        const auto *cfa = sensor_cfa_.data() +
                          (row % sensor_cfa_size_) * sensor_cfa_size_;
        unsigned cfa_col = 0;
        for (unsigned col = 0; col < sensor_width_; ++col) {
          const unsigned channel = cfa[cfa_col];
          const unsigned sample = source[col] > black.channels[channel]
                                      ? source[col] - black.channels[channel]
                                      : 0;
          data_maximum = std::max(data_maximum, sample);
          if (++cfa_col == sensor_cfa_size_) cfa_col = 0;
        }
      }

      val cfa = val::array();
      for (unsigned row = 0; row < sensor_cfa_size_; ++row) {
        for (unsigned col = 0; col < sensor_cfa_size_; ++col) {
          cfa.set(row * sensor_cfa_size_ + col,
                  sensor_cfa_[row * sensor_cfa_size_ + col]);
        }
      }
      sensor_metadata_ = val::object();
      sensor_metadata_.set("width", sensor_width_);
      sensor_metadata_.set("height", sensor_height_);
      sensor_metadata_.set("sampleCount", sensor_.size());
      sensor_metadata_.set("sensorType",
                           sensor_cfa_size_ == 6 ? "xtrans" : "bayer");
      sensor_metadata_.set("cfaSize", sensor_cfa_size_);
      sensor_metadata_.set("cfaPattern", cfa);
      sensor_metadata_.set("whiteLevel", color.maximum);
      unsigned scale_range = 0;
      if (color.maximum > black.common) {
        // Mirror LibRaw's adjust_maximum() policy. Its effective demosaic range
        // can be lower than the advertised white level when a frame's brightest
        // meaningful sample is sufficiently close to that level.
        scale_range = color.maximum - black.common;
        libraw_decoder_info_t decoder{};
        processor_.get_decoder_info(&decoder);
        // Preview disables this full-frame adjustment for its display decode.
        // A captured mosaic is reused by export, so retain export's default
        // scale range instead of leaking the preview-only parameter into it.
        float threshold = opened_for_preview
                              ? LIBRAW_DEFAULT_ADJUST_MAXIMUM_THRESHOLD
                              : processor_.imgdata.params.adjust_maximum_thr;
        if (threshold > 0.99999f) {
          threshold = LIBRAW_DEFAULT_ADJUST_MAXIMUM_THRESHOLD;
        }
        if (!(decoder.decoder_flags & LIBRAW_DECODER_FIXEDMAXC) &&
            threshold >= 0.00001f && data_maximum > 0 &&
            data_maximum < scale_range &&
            data_maximum > scale_range * threshold) {
          scale_range = data_maximum;
        }
      }
      sensor_metadata_.set("demosaicScaleRange", scale_range);
      const auto pre_multipliers =
          aahd_pre_multipliers(black, scale_range);
      val pre_multiplier_array = val::array();
      for (unsigned channel = 0; channel < 4; ++channel) {
        pre_multiplier_array.set(channel, pre_multipliers[channel]);
      }
      sensor_metadata_.set("demosaicPreMultipliers", pre_multiplier_array);
      sensor_metadata_.set("orientation", sensor_orientation_);

      val black_levels = val::array();
      val camera_white_balance = val::array();
      for (unsigned channel = 0; channel < 4; ++channel) {
        black_levels.set(channel, black.channels[channel]);
        camera_white_balance.set(channel, color.cam_mul[channel]);
      }
      sensor_metadata_.set("blackLevels", black_levels);
      sensor_metadata_.set("cameraWhiteBalance", camera_white_balance);

      val xyz_to_camera = val::array();
      for (unsigned channel = 0; channel < 4; ++channel) {
        for (unsigned xyz = 0; xyz < 3; ++xyz) {
          xyz_to_camera.set(channel * 3 + xyz, color.cam_xyz[channel][xyz]);
        }
      }
      sensor_metadata_.set("xyzToCamera", xyz_to_camera);

      static constexpr float yuv_coefficients[3][3] = {
          {0.2627f, 0.6780f, 0.0593f},
          {-0.13963f, -0.36037f, 0.5f},
          {0.5034f, -0.4629f, -0.0405f},
      };
      val rgb_camera = val::array();
      val aahd_yuv_matrix = val::array();
      val xtrans_lab_matrix = val::array();
      val prophoto_matrix = val::array();
      static constexpr double xyz_rgb[3][3] = {
          {0.4124564, 0.3575761, 0.1804375},
          {0.2126729, 0.7151522, 0.0721750},
          {0.0193339, 0.1191920, 0.9503041},
      };
      static constexpr float d65_white[3] = {0.95047f, 1.0f, 1.08883f};
      for (unsigned row = 0; row < 3; ++row) {
        for (unsigned col = 0; col < 4; ++col) {
          rgb_camera.set(row * 4 + col, color.rgb_cam[row][col]);
          float yuv = 0;
          float lab = 0;
          float prophoto = 0;
          for (unsigned term = 0; term < 3; ++term) {
            yuv += yuv_coefficients[row][term] * color.rgb_cam[term][col];
            lab += static_cast<float>(xyz_rgb[row][term] *
                                      color.rgb_cam[term][col] /
                                      d65_white[row]);
            prophoto += float(LibRaw_constants::prophoto_rgb[row][term] *
                              color.rgb_cam[term][col]);
          }
          if (col < 3) aahd_yuv_matrix.set(row * 3 + col, yuv);
          if (col < 3) xtrans_lab_matrix.set(row * 3 + col, lab);
          prophoto_matrix.set(row * 4 + col, prophoto);
        }
      }
      sensor_metadata_.set("rgbCamera", rgb_camera);
      sensor_metadata_.set("aahdYuvMatrix", aahd_yuv_matrix);
      sensor_metadata_.set("xtransLabMatrix", xtrans_lab_matrix);
      sensor_metadata_.set("librawProPhotoMatrix", prophoto_matrix);
      sensor_timings_.total_ms = emscripten_get_now() - total_started_at_;
    }
    return sensor_metadata_;
  }

  void capture_sensor_mosaic() {
    require_opened();
    if (!sensor_.empty()) return;
    const int status = ensure_unpacked();
    if (status != LIBRAW_SUCCESS) {
      release_decoder_state();
      fail("unpack the sensor mosaic", status);
    }

    const auto &sizes = processor_.imgdata.sizes;
    const auto &idata = processor_.imgdata.idata;
    if (processor_.imgdata.rawdata.raw_image == nullptr ||
        (idata.filters != 9 && idata.filters <= 1000)) {
      release_decoder_state();
      throw std::runtime_error(
          "LibRaw did not return a Bayer or X-Trans sensor mosaic");
    }
    if (sizes.width == 0 || sizes.height == 0 ||
        sizes.left_margin + sizes.width > sizes.raw_width ||
        sizes.top_margin + sizes.height > sizes.raw_height ||
        sizes.raw_pitch < sizes.raw_width * sizeof(std::uint16_t)) {
      release_decoder_state();
      throw std::runtime_error("LibRaw returned invalid sensor geometry");
    }
    const auto black = adjusted_black_levels();
    sensor_black_channels_ = black.channels;
    sensor_black_common_ = black.common;
    sensor_black_captured_ = true;
    sensor_width_ = sizes.width;
    sensor_height_ = sizes.height;
    sensor_orientation_ = sizes.flip;
    sensor_cfa_size_ = idata.filters == 9 ? 6 : 2;
    for (unsigned row = 0; row < sensor_cfa_size_; ++row) {
      for (unsigned col = 0; col < sensor_cfa_size_; ++col) {
        sensor_cfa_[row * sensor_cfa_size_ + col] =
            processor_.COLOR(row, col);
      }
    }

    const double copy_started_at = emscripten_get_now();
    sensor_.resize(static_cast<std::size_t>(sizes.width) * sizes.height);
    const std::size_t source_stride = sizes.raw_pitch / sizeof(std::uint16_t);
    for (unsigned row = 0; row < sizes.height; ++row) {
      const auto *source = processor_.imgdata.rawdata.raw_image +
                           (row + sizes.top_margin) * source_stride +
                           sizes.left_margin;
      auto *destination =
          sensor_.data() + static_cast<std::size_t>(row) * sizes.width;
      std::memcpy(destination, source, sizes.width * sizeof(std::uint16_t));
    }
    sensor_timings_.mosaic_copy_ms = emscripten_get_now() - copy_started_at;
  }

  val sensor_timings() const {
    if (sensor_.empty()) {
      throw std::runtime_error("LibRaw sensor_info() must be called first");
    }
    val result = val::object();
    result.set("inputCopyMs", sensor_timings_.input_copy_ms);
    result.set("openMs", sensor_timings_.open_ms);
    result.set("unpackMs", sensor_timings_.unpack_ms);
    result.set("mosaicCopyMs", sensor_timings_.mosaic_copy_ms);
    result.set("totalMs", sensor_timings_.total_ms);
    return result;
  }

  val sensor_view(std::size_t offset, std::size_t length) const {
    if (sensor_.empty()) {
      throw std::runtime_error("LibRaw sensor_info() must be called first");
    }
    if (offset > sensor_.size() || length > sensor_.size() - offset) {
      throw std::runtime_error("LibRaw sensor view exceeds the visible mosaic");
    }
    return val(typed_memory_view(length, sensor_.data() + offset));
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
  std::vector<std::uint16_t> sensor_;
  std::array<unsigned, 36> sensor_cfa_{};
  std::array<unsigned, 4> sensor_black_channels_{};
  libraw_processed_image_t *image_ = nullptr;
  unsigned sensor_width_ = 0;
  unsigned sensor_height_ = 0;
  unsigned sensor_orientation_ = 0;
  unsigned sensor_cfa_size_ = 0;
  unsigned sensor_black_common_ = 0;
  bool sensor_black_captured_ = false;
  bool opened_ = false;
  bool unpacked_ = false;
  bool half_size_ = false;
  int quality_ = 12;
  double total_started_at_ = 0;
  DecodeTimings timings_;
  SensorTimings sensor_timings_;
  val sensor_metadata_ = val::undefined();

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

  const char *unsupported_decoder_error() {
    libraw_decoder_info_t decoder{};
    processor_.get_decoder_info(&decoder);
    if (decoder.decoder_name == nullptr ||
        !(decoder.decoder_flags & LIBRAW_DECODER_UNSUPPORTED_FORMAT)) {
      return nullptr;
    }
    if (std::strcmp(decoder.decoder_name, "nikon_he_load_raw()") == 0 ||
        std::strcmp(decoder.decoder_name,
                    "nikon_he_load_raw_placeholder()") == 0) {
      return NIKON_HIGH_EFFICIENCY_RAW_ERROR;
    }
    if (std::strcmp(decoder.decoder_name,
                    "vc5_dng_load_raw_placeholder()") == 0) {
      return GOPRO_GPR_ERROR;
    }
    if (std::strcmp(decoder.decoder_name,
                    "jxl_dng_load_raw_placeholder()") == 0) {
      return JPEG_XL_DNG_ERROR;
    }
    return nullptr;
  }

  int ensure_unpacked() {
    if (unpacked_) {
      return LIBRAW_SUCCESS;
    }
    const double started_at = emscripten_get_now();
    const int status = processor_.unpack();
    timings_.unpack_ms = emscripten_get_now() - started_at;
    sensor_timings_.input_copy_ms = timings_.input_copy_ms;
    sensor_timings_.open_ms = timings_.open_ms;
    sensor_timings_.unpack_ms = timings_.unpack_ms;
    unpacked_ = status == LIBRAW_SUCCESS;
    return status;
  }

  struct AdjustedBlackLevels {
    std::array<unsigned, 4> channels;
    unsigned common;
  };

  std::array<float, 4>
  aahd_pre_multipliers(const AdjustedBlackLevels &black,
                       unsigned maximum) {
    // Mirror scale_colors() through its final pre_mul normalization. Auto-WB
    // alone needs another mosaic scan; camera metadata stays constant-time.
    const auto &sizes = processor_.imgdata.sizes;
    const auto &color = processor_.imgdata.rawdata.color;
    std::array<float, 4> pre;
    std::copy(std::begin(color.pre_mul), std::end(color.pre_mul), pre.begin());

    if (color.cam_mul[0] < -0.5f ||
        (color.cam_mul[0] <= 0.00001f &&
         !(processor_.imgdata.rawparams.options &
           LIBRAW_RAWOPTIONS_CAMERAWB_FALLBACK_TO_DAYLIGHT))) {
      std::array<double, 8> totals{};
      for (unsigned block_row = 0; block_row < sizes.height;
           block_row += 8) {
        for (unsigned block_col = 0; block_col < sizes.width;
             block_col += 8) {
          std::array<unsigned, 8> block{};
          bool clipped = false;
          for (unsigned row = block_row;
               row < block_row + 8 && row < sizes.height && !clipped; ++row) {
            for (unsigned col = block_col;
                 col < block_col + 8 && col < sizes.width; ++col) {
              const unsigned channel = processor_.COLOR(row, col);
              const auto sample =
                  sensor_[static_cast<std::size_t>(row) * sizes.width + col];
              const int value = sample > black.channels[channel]
                                    ? sample - black.channels[channel]
                                    : 0;
              if (value > static_cast<int>(maximum) - 25) {
                clipped = true;
                break;
              }
              block[channel] += value;
              ++block[channel + 4];
            }
          }
          if (!clipped) {
            for (unsigned channel = 0; channel < 8; ++channel) {
              totals[channel] += block[channel];
            }
          }
        }
      }
      for (unsigned channel = 0; channel < 4; ++channel) {
        if (totals[channel] != 0) {
          pre[channel] =
              static_cast<float>(totals[channel + 4] / totals[channel]);
        }
      }
    }

    if (color.cam_mul[0] > 0.00001f) {
      std::array<unsigned, 8> white{};
      for (unsigned row = 0; row < 8; ++row) {
        for (unsigned col = 0; col < 8; ++col) {
          const unsigned channel = processor_.COLOR(row, col);
          if (color.white[row][col] != 0) {
            white[channel] += color.white[row][col];
          }
          ++white[channel + 4];
        }
      }
      if (color.as_shot_wb_applied) {
        pre.fill(1);
      } else if (white[0] && white[1] && white[2] && white[3]) {
        for (unsigned channel = 0; channel < 4; ++channel) {
          pre[channel] =
              static_cast<float>(white[channel + 4]) / white[channel];
        }
      } else if (color.cam_mul[2] > 0.00001f) {
        std::copy(std::begin(color.cam_mul), std::end(color.cam_mul),
                  pre.begin());
      }
    }

    if (pre[1] == 0) {
      pre[1] = 1;
    }
    if (pre[3] == 0) {
      pre[3] = processor_.imgdata.idata.colors < 4 ? pre[1] : 1;
    }
    const float largest = *std::max_element(pre.begin(), pre.end());
    if (largest > 0.00001f) {
      for (float &multiplier : pre) {
        multiplier /= largest;
      }
    }
    return pre;
  }

  AdjustedBlackLevels adjusted_black_levels() {
    const auto &source = processor_.imgdata.rawdata.color;
    std::array<unsigned, LIBRAW_CBLACK_SIZE> cblack;
    std::copy(std::begin(source.cblack), std::end(source.cblack),
              cblack.begin());
    unsigned black = source.black;
    const unsigned filters = processor_.imgdata.idata.filters;

    if (filters > 1000 && (cblack[4] + 1) / 2 == 1 &&
        (cblack[5] + 1) / 2 == 1) {
      int colors[4];
      int last_green = -1;
      unsigned green_count = 0;
      for (unsigned index = 0; index < 4; ++index) {
        colors[index] = processor_.FC(index / 2, index % 2);
        if (colors[index] == 1) {
          ++green_count;
          last_green = index;
        }
      }
      if (green_count > 1 && last_green >= 0) {
        colors[last_green] = 3;
      }
      for (unsigned index = 0; index < 4; ++index) {
        cblack[colors[index]] +=
            cblack[6 + index / 2 % cblack[4] * cblack[5] +
                   index % 2 % cblack[5]];
      }
      cblack[4] = cblack[5] = 0;
    } else if (filters <= 1000 && cblack[4] == 1 && cblack[5] == 1) {
      for (unsigned channel = 0; channel < 4; ++channel) {
        cblack[channel] += cblack[6];
      }
      cblack[4] = cblack[5] = 0;
    }

    unsigned common = cblack[3];
    for (unsigned channel = 0; channel < 3; ++channel) {
      common = std::min(common, cblack[channel]);
    }
    for (unsigned channel = 0; channel < 4; ++channel) {
      cblack[channel] -= common;
    }
    black += common;

    if (cblack[4] != 0 && cblack[5] != 0) {
      common = cblack[6];
      for (unsigned index = 1; index < cblack[4] * cblack[5]; ++index) {
        common = std::min(common, cblack[6 + index]);
      }
      bool has_residual = false;
      for (unsigned index = 0; index < cblack[4] * cblack[5]; ++index) {
        cblack[6 + index] -= common;
        has_residual |= cblack[6 + index] != 0;
      }
      black += common;
      if (has_residual) {
        throw SpatialBlackLevelsUnsupported();
      }
      cblack[4] = cblack[5] = 0;
    }

    std::array<unsigned, 4> result;
    for (unsigned channel = 0; channel < 4; ++channel) {
      result[channel] = cblack[channel] + black;
    }
    return {result, black};
  }

  [[noreturn]] static void fail(const char *operation, int status) {
    throw std::runtime_error(std::string("LibRaw could not ") + operation +
                             ": " + LibRaw::strerror(status));
  }
};

} // namespace

EMSCRIPTEN_BINDINGS(lutify_libraw) {
  emscripten::class_<BrowserLibRaw>("LibRaw")
      .constructor<>()
      .function("open", &BrowserLibRaw::open)
      .function("openPreview", &BrowserLibRaw::open_preview)
      .function("openWithQuality", &BrowserLibRaw::open_with_quality)
      .function("metadata", &BrowserLibRaw::metadata)
      .function("thumbnailData", &BrowserLibRaw::thumbnail_data)
      .function("xtransCbrtView", &BrowserLibRaw::xtrans_cbrt_view)
      .function("usesParallelUnpack", &BrowserLibRaw::uses_parallel_unpack)
      .function("imageInfo", &BrowserLibRaw::image_info)
      .function("imageInfoRetainingDecoder",
                &BrowserLibRaw::image_info_retaining_decoder)
      .function("discardImage", &BrowserLibRaw::discard_image)
      .function("enableDemosaicCapture",
                &BrowserLibRaw::enable_demosaic_capture)
      .function("demosaicView", &BrowserLibRaw::demosaic_view)
      .function("supportsWebGpuAahd", &BrowserLibRaw::supports_webgpu_aahd)
      .function("supportsWebGpuXtrans",
                &BrowserLibRaw::supports_webgpu_xtrans)
      .function("timings", &BrowserLibRaw::timings)
      .function("imageView", &BrowserLibRaw::image_view)
      .function("sensorInfo", &BrowserLibRaw::sensor_info)
      .function("captureSensorMosaic",
                &BrowserLibRaw::capture_sensor_mosaic)
      .function("finishSensorInfo", &BrowserLibRaw::finish_sensor_info)
      .function("sensorTimings", &BrowserLibRaw::sensor_timings)
      .function("sensorView", &BrowserLibRaw::sensor_view);
}
