#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
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
  }

private:
  double process_started_at_ = 0;
  double demosaic_started_at_ = 0;
  double demosaic_finished_at_ = 0;
  double color_started_at_ = 0;
  double color_finished_at_ = 0;

  static void start_demosaic(void *raw) {
    static_cast<TimedLibRaw *>(raw)->demosaic_started_at_ = emscripten_get_now();
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
    open_with_quality(bytes, half_size, 12);
  }

  void open_with_quality(const val &bytes, bool half_size, int quality) {
    if (quality != 3 && quality != 4 && quality != 12) {
      throw std::runtime_error(
          "LibRaw quality must be AHD (3), DCB (4), or AAHD (12)");
    }
    clear_image();
    sensor_.clear();
    processor_.recycle();
    timings_ = {};
    sensor_timings_ = {};
    unpacked_ = false;
    quality_ = quality;
    total_started_at_ = emscripten_get_now();
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

  val sensor_info() {
    require_opened();
    if (sensor_.empty()) {
      const int status = ensure_unpacked();
      if (status != LIBRAW_SUCCESS) {
        release_decoder_state();
        fail("unpack the sensor mosaic", status);
      }

      const auto &sizes = processor_.imgdata.sizes;
      const auto &idata = processor_.imgdata.idata;
      const auto &color = processor_.imgdata.rawdata.color;
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

      const double copy_started_at = emscripten_get_now();
      sensor_.resize(static_cast<std::size_t>(sizes.width) * sizes.height);
      const std::size_t source_stride = sizes.raw_pitch / sizeof(std::uint16_t);
      for (unsigned row = 0; row < sizes.height; ++row) {
        const auto *source = processor_.imgdata.rawdata.raw_image +
                             (row + sizes.top_margin) * source_stride +
                             sizes.left_margin;
        std::memcpy(sensor_.data() + static_cast<std::size_t>(row) * sizes.width,
                    source, sizes.width * sizeof(std::uint16_t));
      }
      sensor_timings_.mosaic_copy_ms = emscripten_get_now() - copy_started_at;
      sensor_timings_.total_ms = emscripten_get_now() - total_started_at_;

      val cfa = val::array();
      const unsigned cfa_size = idata.filters == 9 ? 6 : 2;
      for (unsigned row = 0; row < cfa_size; ++row) {
        for (unsigned col = 0; col < cfa_size; ++col) {
          cfa.set(row * cfa_size + col, processor_.COLOR(row, col));
        }
      }
      sensor_metadata_ = val::object();
      sensor_metadata_.set("width", sizes.width);
      sensor_metadata_.set("height", sizes.height);
      sensor_metadata_.set("sampleCount", sensor_.size());
      sensor_metadata_.set("sensorType", idata.filters == 9 ? "xtrans" : "bayer");
      sensor_metadata_.set("cfaSize", cfa_size);
      sensor_metadata_.set("cfaPattern", cfa);
      sensor_metadata_.set("whiteLevel", color.maximum);
      sensor_metadata_.set("orientation", sizes.flip);

      val black_levels = val::array();
      val camera_white_balance = val::array();
      const auto adjusted_black = adjusted_black_levels();
      for (unsigned channel = 0; channel < 4; ++channel) {
        black_levels.set(channel, adjusted_black[channel]);
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
    }
    return sensor_metadata_;
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
  libraw_processed_image_t *image_ = nullptr;
  bool opened_ = false;
  bool unpacked_ = false;
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

  std::array<unsigned, 4> adjusted_black_levels() {
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
        throw std::runtime_error(
            "Spatially varying RAW black levels are not supported");
      }
      cblack[4] = cblack[5] = 0;
    }

    std::array<unsigned, 4> result;
    for (unsigned channel = 0; channel < 4; ++channel) {
      result[channel] = cblack[channel] + black;
    }
    return result;
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
      .function("openWithQuality", &BrowserLibRaw::open_with_quality)
      .function("metadata", &BrowserLibRaw::metadata)
      .function("thumbnailData", &BrowserLibRaw::thumbnail_data)
      .function("imageInfo", &BrowserLibRaw::image_info)
      .function("timings", &BrowserLibRaw::timings)
      .function("imageView", &BrowserLibRaw::image_view)
      .function("sensorInfo", &BrowserLibRaw::sensor_info)
      .function("sensorTimings", &BrowserLibRaw::sensor_timings)
      .function("sensorView", &BrowserLibRaw::sensor_view);
}
