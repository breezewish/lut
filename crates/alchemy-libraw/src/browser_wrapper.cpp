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

  void enable_aahd_capture() {
    capture_aahd_ = true;
    aahd_input_.clear();
    aahd_horizontal_.clear();
    aahd_vertical_.clear();
    aahd_chosen_directions_.clear();
    aahd_horizontal_homogeneity_.clear();
    aahd_vertical_homogeneity_.clear();
    aahd_directions_.clear();
    aahd_output_.clear();
    aahd_highlight_.clear();
    scale_multipliers_.fill(0);
    output_matrix_.fill(0);
    pre_multipliers_.fill(0);
    yuv_matrix_.fill(0);
    aahd_hot_pixel_ms_ = 0;
  }

  void disable_aahd_capture() {
    capture_aahd_ = false;
    std::vector<std::uint16_t>().swap(aahd_input_);
    std::vector<std::uint16_t>().swap(aahd_horizontal_);
    std::vector<std::uint16_t>().swap(aahd_vertical_);
    std::vector<std::uint8_t>().swap(aahd_chosen_directions_);
    std::vector<std::uint8_t>().swap(aahd_horizontal_homogeneity_);
    std::vector<std::uint8_t>().swap(aahd_vertical_homogeneity_);
    std::vector<std::uint8_t>().swap(aahd_directions_);
    std::vector<std::uint16_t>().swap(aahd_output_);
    std::vector<std::uint16_t>().swap(aahd_highlight_);
  }

  const std::vector<std::uint16_t> &aahd_input() const { return aahd_input_; }
  const std::vector<std::uint16_t> &aahd_output() const { return aahd_output_; }
  const std::vector<std::uint16_t> &aahd_highlight() const {
    return aahd_highlight_;
  }
  const std::vector<std::uint16_t> &aahd_horizontal() const {
    return aahd_horizontal_;
  }
  const std::vector<std::uint16_t> &aahd_vertical() const {
    return aahd_vertical_;
  }
  const std::vector<std::uint8_t> &aahd_directions() const {
    return aahd_directions_;
  }
  const std::vector<std::uint8_t> &aahd_chosen_directions() const {
    return aahd_chosen_directions_;
  }
  const std::vector<std::uint8_t> &aahd_horizontal_homogeneity() const {
    return aahd_horizontal_homogeneity_;
  }
  const std::vector<std::uint8_t> &aahd_vertical_homogeneity() const {
    return aahd_vertical_homogeneity_;
  }
  const std::array<float, 4> &scale_multipliers() const {
    return scale_multipliers_;
  }
  const std::array<float, 12> &output_matrix() const { return output_matrix_; }
  const std::array<float, 4> &pre_multipliers() const {
    return pre_multipliers_;
  }
  const std::array<float, 9> &yuv_matrix() const { return yuv_matrix_; }
  const std::array<unsigned, 3> &channel_minimum() const {
    return channel_minimum_;
  }
  const std::array<unsigned, 3> &channel_maximum() const {
    return channel_maximum_;
  }
  double aahd_hot_pixel_ms() const { return aahd_hot_pixel_ms_; }

  void mark_aahd_hot_stage(bool finished) {
    if (!capture_aahd_) return;
    if (finished) {
      aahd_hot_pixel_ms_ = emscripten_get_now() - aahd_hot_started_at_;
    } else {
      aahd_hot_started_at_ = emscripten_get_now();
    }
  }

  void capture_aahd_candidates(const void *horizontal, const void *vertical,
                               const char *directions,
                               int padded_width, int padded_height,
                               int margin) {
    if (!capture_aahd_) return;
    const auto width = imgdata.sizes.iwidth;
    const auto height = imgdata.sizes.iheight;
    if (padded_width != int(width) + margin * 2 ||
        padded_height != int(height) + margin * 2) {
      throw std::runtime_error("LibRaw returned invalid AAHD capture geometry");
    }
    const auto *horizontal_rgb =
        static_cast<const std::uint16_t *>(horizontal);
    const auto *vertical_rgb = static_cast<const std::uint16_t *>(vertical);
    const auto rgb_samples = static_cast<std::size_t>(width) * height * 3;
    aahd_horizontal_.resize(rgb_samples);
    aahd_vertical_.resize(rgb_samples);
    copy_aahd_directions(aahd_directions_, directions, padded_width, margin);
    for (unsigned row = 0; row < height; ++row) {
      const auto padded_offset =
          (static_cast<std::size_t>(row + margin) * padded_width + margin);
      const auto rgb_offset = static_cast<std::size_t>(row) * width * 3;
      std::memcpy(aahd_horizontal_.data() + rgb_offset,
                  horizontal_rgb + padded_offset * 3,
                  static_cast<std::size_t>(width) * 3 * sizeof(std::uint16_t));
      std::memcpy(aahd_vertical_.data() + rgb_offset,
                  vertical_rgb + padded_offset * 3,
                  static_cast<std::size_t>(width) * 3 * sizeof(std::uint16_t));
    }
  }

  void capture_aahd_chosen_directions(const char *directions,
                                      const char *horizontal_homogeneity,
                                      const char *vertical_homogeneity,
                                      int padded_width, int padded_height,
                                      int margin) {
    if (!capture_aahd_)
      return;
    if (padded_width != int(imgdata.sizes.iwidth) + margin * 2 ||
        padded_height != int(imgdata.sizes.iheight) + margin * 2) {
      throw std::runtime_error("LibRaw returned invalid AAHD capture geometry");
    }
    copy_aahd_directions(aahd_chosen_directions_, directions, padded_width,
                         margin);
    copy_aahd_directions(aahd_horizontal_homogeneity_, horizontal_homogeneity,
                         padded_width, margin);
    copy_aahd_directions(aahd_vertical_homogeneity_, vertical_homogeneity,
                         padded_width, margin);
  }

protected:
  void scale_colors_loop(float scale_mul[4]) override {
    if (capture_aahd_) {
      std::copy(scale_mul, scale_mul + 4, scale_multipliers_.begin());
    }
    LibRaw::scale_colors_loop(scale_mul);
  }

  void convert_to_rgb_loop(float out_cam[3][4]) override {
    if (capture_aahd_) {
      std::copy(&out_cam[0][0], &out_cam[0][0] + 12,
                output_matrix_.begin());
      copy_current_image(aahd_highlight_);
    }
    LibRaw::convert_to_rgb_loop(out_cam);
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
  bool capture_aahd_ = false;
  std::vector<std::uint16_t> aahd_input_;
  std::vector<std::uint16_t> aahd_horizontal_;
  std::vector<std::uint16_t> aahd_vertical_;
  std::vector<std::uint8_t> aahd_chosen_directions_;
  std::vector<std::uint8_t> aahd_horizontal_homogeneity_;
  std::vector<std::uint8_t> aahd_vertical_homogeneity_;
  std::vector<std::uint8_t> aahd_directions_;
  std::vector<std::uint16_t> aahd_output_;
  std::vector<std::uint16_t> aahd_highlight_;
  std::array<float, 4> scale_multipliers_{};
  std::array<float, 12> output_matrix_{};
  std::array<float, 4> pre_multipliers_{};
  std::array<float, 9> yuv_matrix_{};
  std::array<unsigned, 3> channel_minimum_{};
  std::array<unsigned, 3> channel_maximum_{};
  double aahd_hot_started_at_ = 0;
  double aahd_hot_pixel_ms_ = 0;
  double preview_resize_ms_ = 0;
  unsigned preview_max_edge_ = 0;

  void copy_aahd_directions(std::vector<std::uint8_t> &destination,
                            const char *source, int padded_width, int margin) {
    const auto width = imgdata.sizes.iwidth;
    const auto height = imgdata.sizes.iheight;
    destination.resize(static_cast<std::size_t>(width) * height);
    for (unsigned row = 0; row < height; ++row) {
      const auto padded_offset =
          static_cast<std::size_t>(row + margin) * padded_width + margin;
      std::memcpy(destination.data() + static_cast<std::size_t>(row) * width,
                  source + padded_offset, width);
    }
  }

  void capture_aahd_input() {
    static constexpr float yuv_coefficients[3][3] = {
        {0.2627f, 0.6780f, 0.0593f},
        {-0.13963f, -0.36037f, 0.5f},
        {0.5034f, -0.4629f, -0.0405f},
    };
    const auto width = imgdata.sizes.iwidth;
    const auto height = imgdata.sizes.iheight;
    std::copy(std::begin(imgdata.color.pre_mul),
              std::end(imgdata.color.pre_mul), pre_multipliers_.begin());
    for (unsigned row = 0; row < 3; ++row) {
      for (unsigned col = 0; col < 3; ++col) {
        float value = 0;
        for (unsigned term = 0; term < 3; ++term) {
          value += yuv_coefficients[row][term] *
                   imgdata.color.rgb_cam[term][col];
        }
        yuv_matrix_[row * 3 + col] = value;
      }
    }
    aahd_input_.resize(static_cast<std::size_t>(width) * height);
    for (unsigned channel = 0; channel < 3; ++channel) {
      channel_minimum_[channel] = imgdata.image[0][channel];
      channel_maximum_[channel] = 0;
    }
    for (unsigned row = 0; row < height; ++row) {
      for (unsigned col = 0; col < width; ++col) {
        unsigned channel = COLOR(row, col);
        if (channel == 3) channel = 1;
        const auto sample = imgdata.image[row * width + col][channel];
        aahd_input_[static_cast<std::size_t>(row) * width + col] = sample;
        if (sample != 0) {
          channel_minimum_[channel] =
              std::min(channel_minimum_[channel], unsigned(sample));
          channel_maximum_[channel] =
              std::max(channel_maximum_[channel], unsigned(sample));
        }
      }
    }
  }

  void copy_current_image(std::vector<std::uint16_t> &destination) const {
    const auto samples =
        static_cast<std::size_t>(imgdata.sizes.iwidth) * imgdata.sizes.iheight;
    destination.resize(samples * 3);
    for (std::size_t index = 0; index < samples; ++index) {
      for (unsigned channel = 0; channel < 3; ++channel) {
        destination[index * 3 + channel] = imgdata.image[index][channel];
      }
    }
  }

  void capture_aahd_output() { copy_current_image(aahd_output_); }

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
    if (processor->capture_aahd_) processor->capture_aahd_input();
    if (processor->preview_max_edge_ != 0) {
      const double resize_started_at = emscripten_get_now();
      processor->resize_preview();
      processor->preview_resize_ms_ += emscripten_get_now() - resize_started_at;
    }
  }

  static void finish_demosaic(void *raw) {
    auto *processor = static_cast<TimedLibRaw *>(raw);
    processor->demosaic_finished_at_ = emscripten_get_now();
    if (processor->capture_aahd_) processor->capture_aahd_output();
  }

  static void start_color_conversion(void *raw) {
    static_cast<TimedLibRaw *>(raw)->color_started_at_ = emscripten_get_now();
  }

  static void finish_color_conversion(void *raw) {
    static_cast<TimedLibRaw *>(raw)->color_finished_at_ = emscripten_get_now();
  }
};

extern "C" void alchemy_capture_aahd_candidates(
    LibRaw *raw, const void *horizontal, const void *vertical,
    const char *directions, int padded_width, int padded_height,
    int margin) {
  static_cast<TimedLibRaw *>(raw)->capture_aahd_candidates(
      horizontal, vertical, directions, padded_width, padded_height, margin);
}

extern "C" void alchemy_capture_aahd_chosen_directions(
    LibRaw *raw, const char *directions, const char *horizontal,
    const char *vertical, int padded_width, int padded_height, int margin) {
  static_cast<TimedLibRaw *>(raw)->capture_aahd_chosen_directions(
      directions, horizontal, vertical, padded_width, padded_height, margin);
}

extern "C" void alchemy_mark_aahd_hot_stage(LibRaw *raw, int finished) {
  static_cast<TimedLibRaw *>(raw)->mark_aahd_hot_stage(finished != 0);
}

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
    processor_.disable_aahd_capture();
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

      static constexpr float yuv_coefficients[3][3] = {
          {0.2627f, 0.6780f, 0.0593f},
          {-0.13963f, -0.36037f, 0.5f},
          {0.5034f, -0.4629f, -0.0405f},
      };
      val rgb_camera = val::array();
      val aahd_yuv_matrix = val::array();
      val prophoto_matrix = val::array();
      for (unsigned row = 0; row < 3; ++row) {
        for (unsigned col = 0; col < 4; ++col) {
          rgb_camera.set(row * 4 + col, color.rgb_cam[row][col]);
          float yuv = 0;
          float prophoto = 0;
          for (unsigned term = 0; term < 3; ++term) {
            yuv += yuv_coefficients[row][term] * color.rgb_cam[term][col];
            prophoto += float(LibRaw_constants::prophoto_rgb[row][term] *
                              color.rgb_cam[term][col]);
          }
          if (col < 3) aahd_yuv_matrix.set(row * 3 + col, yuv);
          prophoto_matrix.set(row * 4 + col, prophoto);
        }
      }
      sensor_metadata_.set("rgbCamera", rgb_camera);
      sensor_metadata_.set("aahdYuvMatrix", aahd_yuv_matrix);
      sensor_metadata_.set("librawProPhotoMatrix", prophoto_matrix);
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

  val aahd_reference_info() {
    if (image_ != nullptr) {
      throw std::runtime_error(
          "AAHD reference capture must be enabled before image_info()");
    }
    if (quality_ != 12 || half_size_) {
      throw std::runtime_error(
          "AAHD reference capture requires full-resolution quality 12");
    }
    processor_.enable_aahd_capture();
    image_info();
    if (processor_.aahd_input().empty() ||
        processor_.aahd_horizontal().empty() ||
        processor_.aahd_vertical().empty() ||
        processor_.aahd_chosen_directions().empty() ||
        processor_.aahd_horizontal_homogeneity().empty() ||
        processor_.aahd_vertical_homogeneity().empty() ||
        processor_.aahd_directions().empty() ||
        processor_.aahd_output().empty() ||
        processor_.aahd_highlight().empty()) {
      throw std::runtime_error("LibRaw did not capture the AAHD boundaries");
    }

    val result = val::object();
    result.set("width", image_->width);
    result.set("height", image_->height);
    result.set("inputSampleCount", processor_.aahd_input().size());
    result.set("outputSampleCount", processor_.aahd_output().size());
    result.set("highlightSampleCount", processor_.aahd_highlight().size());
    result.set("candidateSampleCount", processor_.aahd_horizontal().size());
    result.set("directionSampleCount", processor_.aahd_directions().size());
    result.set("hotPixelMs", processor_.aahd_hot_pixel_ms());
    result.set("scaleMultipliers", float_array(processor_.scale_multipliers()));
    result.set("preMultipliers", float_array(processor_.pre_multipliers()));
    result.set("yuvMatrix", float_array(processor_.yuv_matrix()));
    result.set("outputMatrix", float_array(processor_.output_matrix()));

    val minimum = val::array();
    val maximum = val::array();
    for (unsigned channel = 0; channel < 3; ++channel) {
      minimum.set(channel, processor_.channel_minimum()[channel]);
      maximum.set(channel, processor_.channel_maximum()[channel]);
    }
    result.set("channelMinimum", minimum);
    result.set("channelMaximum", maximum);
    return result;
  }

  val aahd_input_view(std::size_t offset, std::size_t length) const {
    return reference_view(processor_.aahd_input(), offset, length,
                          "AAHD input");
  }

  val aahd_output_view(std::size_t offset, std::size_t length) const {
    return reference_view(processor_.aahd_output(), offset, length,
                          "AAHD output");
  }

  val aahd_highlight_view(std::size_t offset, std::size_t length) const {
    return reference_view(processor_.aahd_highlight(), offset, length,
                          "AAHD highlight output");
  }

  val aahd_horizontal_view(std::size_t offset, std::size_t length) const {
    return reference_view(processor_.aahd_horizontal(), offset, length,
                          "AAHD horizontal candidate");
  }

  val aahd_vertical_view(std::size_t offset, std::size_t length) const {
    return reference_view(processor_.aahd_vertical(), offset, length,
                          "AAHD vertical candidate");
  }

  val aahd_direction_view(std::size_t offset, std::size_t length) const {
    const auto &source = processor_.aahd_directions();
    if (source.empty()) {
      throw std::runtime_error("AAHD directions are unavailable");
    }
    if (offset > source.size() || length > source.size() - offset) {
      throw std::runtime_error("AAHD direction view exceeds its buffer");
    }
    return val(typed_memory_view(length, source.data() + offset));
  }

  val aahd_chosen_direction_view(std::size_t offset, std::size_t length) const {
    const auto &source = processor_.aahd_chosen_directions();
    if (source.empty()) {
      throw std::runtime_error("AAHD chosen directions are unavailable");
    }
    if (offset > source.size() || length > source.size() - offset) {
      throw std::runtime_error("AAHD chosen direction view exceeds its buffer");
    }
    return val(typed_memory_view(length, source.data() + offset));
  }

  val aahd_horizontal_homogeneity_view(std::size_t offset,
                                       std::size_t length) const {
    return reference_view(processor_.aahd_horizontal_homogeneity(), offset,
                          length, "AAHD horizontal homogeneity");
  }

  val aahd_vertical_homogeneity_view(std::size_t offset,
                                     std::size_t length) const {
    return reference_view(processor_.aahd_vertical_homogeneity(), offset,
                          length, "AAHD vertical homogeneity");
  }

private:
  TimedLibRaw processor_;
  std::vector<std::uint8_t> input_;
  std::vector<std::uint16_t> sensor_;
  libraw_processed_image_t *image_ = nullptr;
  bool opened_ = false;
  bool unpacked_ = false;
  bool half_size_ = false;
  int quality_ = 12;
  double total_started_at_ = 0;
  DecodeTimings timings_;
  SensorTimings sensor_timings_;
  val sensor_metadata_ = val::undefined();

  template <std::size_t Size>
  static val float_array(const std::array<float, Size> &source) {
    val result = val::array();
    for (std::size_t index = 0; index < Size; ++index) {
      result.set(index, source[index]);
    }
    return result;
  }

  template <typename Sample>
  static val reference_view(const std::vector<Sample> &source,
                            std::size_t offset, std::size_t length,
                            const char *name) {
    if (source.empty()) {
      throw std::runtime_error(std::string(name) + " is unavailable");
    }
    if (offset > source.size() || length > source.size() - offset) {
      throw std::runtime_error(std::string(name) + " view exceeds its buffer");
    }
    return val(typed_memory_view(length, source.data() + offset));
  }

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
      .function("openPreview", &BrowserLibRaw::open_preview)
      .function("openWithQuality", &BrowserLibRaw::open_with_quality)
      .function("metadata", &BrowserLibRaw::metadata)
      .function("thumbnailData", &BrowserLibRaw::thumbnail_data)
      .function("imageInfo", &BrowserLibRaw::image_info)
      .function("timings", &BrowserLibRaw::timings)
      .function("imageView", &BrowserLibRaw::image_view)
      .function("sensorInfo", &BrowserLibRaw::sensor_info)
      .function("sensorTimings", &BrowserLibRaw::sensor_timings)
      .function("sensorView", &BrowserLibRaw::sensor_view)
      .function("aahdReferenceInfo", &BrowserLibRaw::aahd_reference_info)
      .function("aahdInputView", &BrowserLibRaw::aahd_input_view)
      .function("aahdHorizontalView", &BrowserLibRaw::aahd_horizontal_view)
      .function("aahdVerticalView", &BrowserLibRaw::aahd_vertical_view)
      .function("aahdChosenDirectionView",
                &BrowserLibRaw::aahd_chosen_direction_view)
      .function("aahdHorizontalHomogeneityView",
                &BrowserLibRaw::aahd_horizontal_homogeneity_view)
      .function("aahdVerticalHomogeneityView",
                &BrowserLibRaw::aahd_vertical_homogeneity_view)
      .function("aahdDirectionView", &BrowserLibRaw::aahd_direction_view)
      .function("aahdOutputView", &BrowserLibRaw::aahd_output_view)
      .function("aahdHighlightView", &BrowserLibRaw::aahd_highlight_view);
}
