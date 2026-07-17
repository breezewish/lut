@group(0) @binding(0) var<storage, read> mosaic: array<u32>;
@group(0) @binding(1) var<storage, read_write> horizontal_rgb: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> vertical_rgb: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> horizontal_yuv: array<vec4i>;
@group(0) @binding(4) var<storage, read_write> vertical_yuv: array<vec4i>;
@group(0) @binding(5) var<storage, read_write> directions: array<u32>;
@group(0) @binding(6) var<storage, read_write> horizontal_homogeneity: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> vertical_homogeneity: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> channel_extrema: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read> gamma_lut: array<f32>;
@group(0) @binding(10) var<storage, read_write> output: array<u32>;
@group(0) @binding(11) var<storage, read> parameters: array<u32>;
@group(0) @binding(12) var<storage, read_write> defect_mask: array<atomic<u32>>;
@group(0) @binding(13) var<storage, read> original_mosaic: array<u32>;
@group(0) @binding(14) var<storage, read_write> highlight_count: atomic<u32>;
@group(0) @binding(15) var<storage, read> refined_direction_plane: array<u32>;

const MARGIN: u32 = 4u;
const HOR: u32 = 2u;
const VER: u32 = 4u;
const HOT: u32 = 8u;
// WebGPU's guaranteed per-dimension workgroup limit; mirrored by TypeScript.
const LINEAR_DISPATCH_WIDTH: u32 = 65535u;

fn width() -> u32 { return parameters[0]; }
fn height() -> u32 { return parameters[1]; }
fn padded_width() -> u32 { return parameters[2]; }
fn padded_height() -> u32 { return parameters[3]; }
fn global_width() -> u32 { return parameters[4]; }
fn origin_x() -> u32 { return parameters[6]; }
fn origin_y() -> u32 { return parameters[7]; }
fn core_x() -> u32 { return parameters[56]; }
fn core_y() -> u32 { return parameters[57]; }
fn core_width() -> u32 { return parameters[58]; }
fn core_height() -> u32 { return parameters[59]; }
fn parameter(index: u32) -> f32 { return bitcast<f32>(parameters[index]); }
fn image_index(x: u32, y: u32) -> u32 {
  return (origin_y() + y) * global_width() + origin_x() + x;
}
fn local_image_index(x: u32, y: u32) -> u32 { return y * width() + x; }
fn padded_index(x: i32, y: i32) -> u32 {
  return u32(y + i32(MARGIN)) * padded_width() + u32(x + i32(MARGIN));
}
fn padded_offset(index: u32, dx: i32, dy: i32) -> u32 {
  return u32(i32(index) + dy * i32(padded_width()) + dx);
}
fn in_image(id: vec3u) -> bool { return id.x < width() && id.y < height(); }
fn in_padded(id: vec3u) -> bool {
  return id.x < padded_width() && id.y < padded_height();
}

fn cfa_color(x: u32, y: u32) -> u32 {
  let channel = parameters[48u + ((origin_y() + y) & 1u) * 2u + ((origin_x() + x) & 1u)];
  return select(channel, 1u, channel == 3u);
}

fn sensor_sample(index: u32) -> u32 {
  let word = mosaic[index / 2u];
  return select(word >> 16u, word & 0xffffu, index % 2u == 0u);
}

fn original_sample(index: u32) -> u32 {
  let word = original_mosaic[index / 2u];
  return select(word >> 16u, word & 0xffffu, index % 2u == 0u);
}

fn scaled_sample(x: u32, y: u32) -> u32 {
  let channel = cfa_color(x, y);
  let value = max(f32(original_sample(local_image_index(x, y))) - parameter(8u + channel), 0.0);
  return u32(clamp(value * parameter(12u + channel), 0.0, 65535.0));
}

fn preprocessed_sample(x: i32, y: i32) -> i32 {
  if x < 0 || y < 0 || x >= i32(width()) || y >= i32(height()) { return 0; }
  let index = u32(y) * width() + u32(x);
  let word = output[index / 2u];
  return i32(select(word >> 16u, word & 0xffffu, index % 2u == 0u));
}

fn preprocess_scaled_sample(x: u32, y: u32) -> u32 {
  let channel = cfa_color(x, y);
  let value = max(f32(sensor_sample(local_image_index(x, y))) - parameter(8u + channel), 0.0);
  return u32(clamp(value * parameter(12u + channel), 0.0, 65535.0));
}

@compute @workgroup_size(16, 16)
fn preprocess_scale_pairs(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = preprocess_scaled_sample(x, id.y);
  let second = preprocess_scaled_sample(x + 1u, id.y);
  output[id.y * pairs_per_row + id.x] = first | (second << 16u);
  if first != 0u {
    let channel = cfa_color(x, id.y);
    atomicMin(&channel_extrema[channel], first);
    atomicMax(&channel_extrema[channel + 3u], first);
  }
  if second != 0u {
    let channel = cfa_color(x + 1u, id.y);
    atomicMin(&channel_extrema[channel], second);
    atomicMax(&channel_extrema[channel + 3u], second);
  }
}

@compute @workgroup_size(16, 16)
fn preprocess_classify_defects(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let center = preprocessed_sample(x, y);
  let west2 = preprocessed_sample(x - 2, y);
  let east2 = preprocessed_sample(x + 2, y);
  let north2 = preprocessed_sample(x, y - 2);
  let south2 = preprocessed_sample(x, y + 2);
  let west = preprocessed_sample(x - 1, y);
  let east = preprocessed_sample(x + 1, y);
  let north = preprocessed_sample(x, y - 1);
  let south = preprocessed_sample(x, y + 1);
  if !hot_or_dead(center, west2, east2, north2, south2,
                  west, east, north, south) { return; }

  let average = (preprocessed_sample(x - 2, y - 2) + north2 +
    preprocessed_sample(x + 2, y - 2) + west2 + east2 +
    preprocessed_sample(x - 2, y + 2) + south2 +
    preprocessed_sample(x + 2, y + 2)) / 8;
  if (center >> 4) <= average && (center << 4) >= average { return; }
  let index = id.y * width() + id.x;
  atomicOr(&defect_mask[index / 32u], 1u << (index & 31u));
}

fn rgb_at(direction: u32, index: u32) -> vec4u {
  if direction == 0u { return horizontal_rgb[index]; }
  return vertical_rgb[index];
}

fn yuv_at(direction: u32, index: u32) -> vec4i {
  if direction == 0u { return horizontal_yuv[index]; }
  return vertical_yuv[index];
}

fn rgb_channel(direction: u32, index: u32, channel: u32) -> i32 {
  return i32(rgb_at(direction, index)[channel]);
}

fn set_rgb_channel(direction: u32, index: u32, channel: u32, value: i32) {
  if direction == 0u {
    var rgb = horizontal_rgb[index];
    rgb[channel] = u32(value);
    horizontal_rgb[index] = rgb;
  } else {
    var rgb = vertical_rgb[index];
    rgb[channel] = u32(value);
    vertical_rgb[index] = rgb;
  }
}

fn square_wrapped(value: i32) -> i32 { return value * value; }

@compute @workgroup_size(16, 16)
fn clear(@builtin(global_invocation_id) id: vec3u) {
  if !in_padded(id) { return; }
  let index = id.y * padded_width() + id.x;
  directions[index] = 0u;
  atomicStore(&horizontal_homogeneity[index], 0u);
  atomicStore(&vertical_homogeneity[index], 0u);
}

@compute @workgroup_size(16, 16)
fn clear_tile(@builtin(global_invocation_id) id: vec3u) {
  if !in_padded(id) { return; }
  let index = id.y * padded_width() + id.x;
  horizontal_rgb[index] = vec4u(0u);
  vertical_rgb[index] = vec4u(0u);
  horizontal_yuv[index] = vec4i(0);
  vertical_yuv[index] = vec4i(0);
  directions[index] = 0u;
  atomicStore(&horizontal_homogeneity[index], 0u);
  atomicStore(&vertical_homogeneity[index], 0u);
}

@compute @workgroup_size(16, 16)
fn initialize(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let source_index = image_index(id.x, id.y);
  if (source_index & 31u) == 0u {
    atomicStore(&defect_mask[source_index / 32u], 0u);
  }
  let channel = cfa_color(id.x, id.y);
  let sample = scaled_sample(id.x, id.y);
  let index = padded_index(i32(id.x), i32(id.y));
  var rgb = vec4u(0u);
  rgb[channel] = sample;
  horizontal_rgb[index] = rgb;
  vertical_rgb[index] = rgb;
  if sample != 0u {
    atomicMin(&channel_extrema[channel], sample);
    atomicMax(&channel_extrema[channel + 3u], sample);
  }
}

@compute @workgroup_size(16, 16)
fn initialize_parity(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let source_index = image_index(id.x, id.y);
  let channel = cfa_color(id.x, id.y);
  let sample = sensor_sample(source_index);
  let index = padded_index(i32(id.x), i32(id.y));
  var rgb = vec4u(0u);
  rgb[channel] = sample;
  horizontal_rgb[index] = rgb;
  vertical_rgb[index] = rgb;
  if defect_at(source_index) != 0u {
    directions[index] = directions[index] | HOT;
  }
}

fn hot_or_dead(center: i32, a: i32, b: i32, c: i32, d: i32,
               e: i32, f: i32, g: i32, h: i32) -> bool {
  return (center > a && center > b && center > c && center > d &&
          center > e && center > f && center > g && center > h) ||
         (center < a && center < b && center < c && center < d &&
          center < e && center < f && center < g && center < h);
}

@compute @workgroup_size(16, 16)
fn hide_hot_pixels(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  let channel = cfa_color(id.x, id.y);
  let row_color = cfa_color(id.x + 1u, id.y);
  let known = channel;
  let center = rgb_channel(0u, index, known);
  let west2 = rgb_channel(0u, padded_offset(index, -2, 0), known);
  let east2 = rgb_channel(0u, padded_offset(index, 2, 0), known);
  let north2 = rgb_channel(0u, padded_offset(index, 0, -2), known);
  let south2 = rgb_channel(0u, padded_offset(index, 0, 2), known);
  let west_cross = rgb_channel(0u, padded_offset(index, -1, 0), select(1u, row_color, channel == 1u));
  let east_cross = rgb_channel(0u, padded_offset(index, 1, 0), select(1u, row_color, channel == 1u));
  let vertical_color = select(1u, row_color ^ 2u, channel == 1u);
  let north_cross = rgb_channel(0u, padded_offset(index, 0, -1), vertical_color);
  let south_cross = rgb_channel(0u, padded_offset(index, 0, 1), vertical_color);
  if !hot_or_dead(center, west2, east2, north2, south2,
                  west_cross, east_cross, north_cross, south_cross) { return; }

  var average = 0i;
  for (var dy = -2; dy <= 2; dy += 2) {
    for (var dx = -2; dx <= 2; dx += 2) {
      if dx != 0 || dy != 0 {
        average += rgb_channel(0u, padded_offset(index, dx, dy), known);
      }
    }
  }
  average /= 8;
  if (center >> 4) <= average && (center << 4) >= average { return; }

  directions[index] = directions[index] | HOT;
  let source_index = image_index(id.x, id.y);
  atomicOr(&defect_mask[source_index / 32u], 1u << (source_index & 31u));
  let horizontal = abs(west2 - east2) + abs(west_cross - east_cross) +
    abs(west_cross - east_cross + east2 - west2);
  let vertical = abs(north2 - south2) + abs(north_cross - south_cross) +
    abs(north_cross - south_cross + south2 - north2);
  let dx = select(0, -1, vertical > horizontal);
  let dy = select(-1, 0, vertical > horizontal);
  let replacement = (rgb_channel(0u, padded_offset(index, 2 * dx, 2 * dy), known) +
    rgb_channel(0u, padded_offset(index, -2 * dx, -2 * dy), known)) / 2;
  set_rgb_channel(1u, index, known, replacement);
}

@compute @workgroup_size(16, 16)
fn copy_corrected(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  horizontal_rgb[index] = vertical_rgb[index];
}

@compute @workgroup_size(16, 16)
fn write_corrected(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first_index = padded_index(i32(x), i32(id.y));
  let second_index = padded_index(i32(x + 1u), i32(id.y));
  let first = horizontal_rgb[first_index][cfa_color(x, id.y)];
  let second = horizontal_rgb[second_index][cfa_color(x + 1u, id.y)];
  pack_pair(vec3u(first), vec3u(second), id.y * pairs_per_row + id.x);
}

fn defect_at(index: u32) -> u32 {
  return (atomicLoad(&defect_mask[index / 32u]) >> (index & 31u)) & 1u;
}

@compute @workgroup_size(16, 16)
fn write_defects(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let first_index = image_index(id.x * 2u, id.y);
  let second_index = first_index + 1u;
  pack_pair(vec3u(defect_at(first_index)), vec3u(defect_at(second_index)),
            id.y * pairs_per_row + id.x);
}

@compute @workgroup_size(16, 16)
fn interpolate_green(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) || cfa_color(id.x, id.y) == 1u { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  let known = cfa_color(id.x, id.y);
  for (var direction = 0u; direction < 2u; direction += 1u) {
    let dx = select(0, 1, direction == 0u);
    let dy = select(1, 0, direction == 0u);
    let negative = padded_offset(index, -dx, -dy);
    let positive = padded_offset(index, dx, dy);
    let h1 = 2 * rgb_channel(direction, negative, 1u) -
      rgb_channel(direction, padded_offset(index, -2 * dx, -2 * dy), known) -
      rgb_channel(direction, index, known);
    let h2 = 2 * rgb_channel(direction, positive, 1u) -
      rgb_channel(direction, padded_offset(index, 2 * dx, 2 * dy), known) -
      rgb_channel(direction, index, known);
    var estimate = rgb_channel(direction, index, known) + (h1 + h2) / 4;
    var low = min(rgb_channel(direction, negative, 1u), rgb_channel(direction, positive, 1u));
    var high = max(rgb_channel(direction, negative, 1u), rgb_channel(direction, positive, 1u));
    low -= low / 8;
    high += high / 8;
    if estimate < low { estimate = low - i32(sqrt(f32(low - estimate))); }
    if estimate > high { estimate = high + i32(sqrt(f32(estimate - high))); }
    estimate = clamp(estimate, i32(atomicLoad(&channel_extrema[1])),
                     i32(atomicLoad(&channel_extrema[4])));
    set_rgb_channel(direction, index, 1u, estimate);
  }
}

@compute @workgroup_size(16, 16)
fn interpolate_rb_at_green(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) || cfa_color(id.x, id.y) != 1u { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  let row_color = cfa_color(id.x + 1u, id.y);
  for (var direction = 0u; direction < 2u; direction += 1u) {
    let dx = select(0, 1, direction == 0u);
    let dy = select(1, 0, direction == 0u);
    let color = row_color ^ (direction << 1u);
    let negative = padded_offset(index, -dx, -dy);
    let positive = padded_offset(index, dx, dy);
    let difference = (rgb_channel(direction, negative, color) - rgb_channel(direction, negative, 1u) +
      rgb_channel(direction, positive, color) - rgb_channel(direction, positive, 1u)) / 2;
    let estimate = clamp(rgb_channel(direction, index, 1u) + difference,
      i32(atomicLoad(&channel_extrema[color])),
      i32(atomicLoad(&channel_extrema[color + 3u])));
    set_rgb_channel(direction, index, color, estimate);
  }
}

fn rb_direction_offset(direction: u32, choice: u32) -> vec2i {
  if direction == 0u {
    return array<vec2i, 3>(vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1))[choice];
  }
  return array<vec2i, 3>(vec2i(-1, -1), vec2i(-1, 0), vec2i(-1, 1))[choice];
}

@compute @workgroup_size(16, 16)
fn interpolate_remaining_rb(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  let site_color = cfa_color(id.x, id.y);
  let row_color = select(site_color, cfa_color(id.x + 1u, id.y), site_color == 1u);
  for (var direction = 0u; direction < 2u; direction += 1u) {
    var color = row_color ^ 2u;
    if site_color == 1u { color ^= direction << 1u; }
    var best_gradient = 0i;
    var best_positive = 0u;
    var best_negative = 0u;
    for (var positive_choice = 0u; positive_choice < 3u; positive_choice += 1u) {
      let positive_delta = rb_direction_offset(direction, positive_choice);
      let positive = padded_offset(index, positive_delta.x, positive_delta.y);
      for (var negative_choice = 0u; negative_choice < 3u; negative_choice += 1u) {
        let negative_delta = rb_direction_offset(direction, negative_choice);
        let negative = padded_offset(index, -negative_delta.x, -negative_delta.y);
        let gradient = abs(2 * rgb_channel(direction, index, 1u) -
          rgb_channel(direction, positive, 1u) - rgb_channel(direction, negative, 1u)) +
          abs(rgb_channel(direction, positive, color) - rgb_channel(direction, negative, color)) / 4 +
          abs(rgb_channel(direction, positive, color) - rgb_channel(direction, positive, 1u) +
              rgb_channel(direction, negative, 1u) - rgb_channel(direction, negative, color)) / 4;
        if best_gradient == 0 || gradient < best_gradient {
          best_gradient = gradient;
          best_positive = positive_choice;
          best_negative = negative_choice;
        }
      }
    }
    let positive_delta = rb_direction_offset(direction, best_positive);
    let negative_delta = rb_direction_offset(direction, best_negative);
    let positive = padded_offset(index, positive_delta.x, positive_delta.y);
    let negative = padded_offset(index, -negative_delta.x, -negative_delta.y);
    let difference = (rgb_channel(direction, positive, color) - rgb_channel(direction, positive, 1u) +
      rgb_channel(direction, negative, color) - rgb_channel(direction, negative, 1u)) / 2;
    let estimate = clamp(rgb_channel(direction, index, 1u) + difference,
      i32(atomicLoad(&channel_extrema[color])),
      i32(atomicLoad(&channel_extrema[color + 3u])));
    set_rgb_channel(direction, index, color, estimate);
  }
}

@compute @workgroup_size(16, 16)
fn convert_candidates_to_yuv(@builtin(global_invocation_id) id: vec3u) {
  if !in_padded(id) { return; }
  let index = id.y * padded_width() + id.x;
  for (var direction = 0u; direction < 2u; direction += 1u) {
    let source = rgb_at(direction, index);
    // LibRaw stores each gamma LUT result in ushort3 before applying yuv_cam.
    // The truncation materially affects AAHD's discrete direction decisions.
    let encoded = vec3f(vec3u(vec3f(
      gamma_lut[source.x], gamma_lut[source.y], gamma_lut[source.z])));
    let converted = vec4i(
      i32(parameter(20) * encoded.x + parameter(21) * encoded.y + parameter(22) * encoded.z),
      i32(parameter(23) * encoded.x + parameter(24) * encoded.y + parameter(25) * encoded.z),
      i32(parameter(26) * encoded.x + parameter(27) * encoded.y + parameter(28) * encoded.z),
      0);
    if direction == 0u { horizontal_yuv[index] = converted; }
    else { vertical_yuv[index] = converted; }
  }
}

fn store_parity_product(direction: u32, index: u32, value: f32) {
  if direction == 0u {
    var rgb = horizontal_rgb[index];
    rgb.w = bitcast<u32>(value);
    horizontal_rgb[index] = rgb;
  } else {
    var rgb = vertical_rgb[index];
    rgb.w = bitcast<u32>(value);
    vertical_rgb[index] = rgb;
  }
}

fn parity_product(direction: u32, index: u32) -> f32 {
  return bitcast<f32>(rgb_at(direction, index).w);
}

fn store_parity_accumulator(direction: u32, index: u32, component: u32, value: f32) {
  var yuv = yuv_at(direction, index);
  yuv[component] = bitcast<i32>(value);
  if direction == 0u { horizontal_yuv[index] = yuv; }
  else { vertical_yuv[index] = yuv; }
}

fn parity_accumulator(direction: u32, index: u32, component: u32) -> f32 {
  return bitcast<f32>(yuv_at(direction, index)[component]);
}

@compute @workgroup_size(16, 16)
fn convert_candidates_to_yuv_parity(@builtin(global_invocation_id) id: vec3u) {
  if !in_padded(id) { return; }
  let index = id.y * padded_width() + id.x;
  for (var direction = 0u; direction < 2u; direction += 1u) {
    let encoded = encoded_rgb(direction, index);
    for (var component = 0u; component < 3u; component += 1u) {
      store_parity_product(
        direction,
        index,
        parameter(20u + component * 3u) * encoded.x);
      let first = parity_product(direction, index);
      store_parity_product(
        direction,
        index,
        parameter(21u + component * 3u) * encoded.y);
      let second = parity_product(direction, index);
      store_parity_accumulator(direction, index, component, first + second);
      let partial = parity_accumulator(direction, index, component);
      store_parity_product(
        direction,
        index,
        parameter(22u + component * 3u) * encoded.z);
      let third = parity_product(direction, index);
      var yuv = yuv_at(direction, index);
      yuv[component] = i32(partial + third);
      if direction == 0u { horizontal_yuv[index] = yuv; }
      else { vertical_yuv[index] = yuv; }
    }
  }
}

fn encoded_rgb(direction: u32, index: u32) -> vec3f {
  let source = rgb_at(direction, index);
  return vec3f(vec3u(vec3f(
    gamma_lut[source.x], gamma_lut[source.y], gamma_lut[source.z])));
}

fn initialize_yuv_products(id: vec3u) {
  if !in_padded(id) { return; }
  let index = id.y * padded_width() + id.x;
  for (var direction = 0u; direction < 2u; direction += 1u) {
    let encoded = encoded_rgb(direction, index);
    let products = vec4i(
      bitcast<i32>(parameter(20) * encoded.x),
      bitcast<i32>(parameter(23) * encoded.x),
      bitcast<i32>(parameter(26) * encoded.x),
      0);
    if direction == 0u { horizontal_yuv[index] = products; }
    else { vertical_yuv[index] = products; }
  }
}

fn store_yuv_product(id: vec3u, component: u32, channel: u32) {
  if !in_padded(id) { return; }
  let index = id.y * padded_width() + id.x;
  for (var direction = 0u; direction < 2u; direction += 1u) {
    let encoded = encoded_rgb(direction, index);
    let product = parameter(20u + component * 3u + channel) * encoded[channel];
    if direction == 0u {
      var rgb = horizontal_rgb[index];
      rgb.w = bitcast<u32>(product);
      horizontal_rgb[index] = rgb;
    } else {
      var rgb = vertical_rgb[index];
      rgb.w = bitcast<u32>(product);
      vertical_rgb[index] = rgb;
    }
  }
}

fn add_yuv_product(id: vec3u, component: u32, finish: bool) {
  if !in_padded(id) { return; }
  let index = id.y * padded_width() + id.x;
  for (var direction = 0u; direction < 2u; direction += 1u) {
    var yuv = yuv_at(direction, index);
    let accumulator = bitcast<f32>(yuv[component]);
    let product = bitcast<f32>(rgb_at(direction, index).w);
    let sum = accumulator + product;
    yuv[component] = select(bitcast<i32>(sum), i32(sum), finish);
    if direction == 0u { horizontal_yuv[index] = yuv; }
    else { vertical_yuv[index] = yuv; }
  }
}

@compute @workgroup_size(16, 16)
fn initialize_yuv_first_products(@builtin(global_invocation_id) id: vec3u) {
  initialize_yuv_products(id);
}

@compute @workgroup_size(16, 16)
fn store_yuv_second_0(@builtin(global_invocation_id) id: vec3u) { store_yuv_product(id, 0u, 1u); }
@compute @workgroup_size(16, 16)
fn add_yuv_second_0(@builtin(global_invocation_id) id: vec3u) { add_yuv_product(id, 0u, false); }
@compute @workgroup_size(16, 16)
fn store_yuv_third_0(@builtin(global_invocation_id) id: vec3u) { store_yuv_product(id, 0u, 2u); }
@compute @workgroup_size(16, 16)
fn finish_yuv_0(@builtin(global_invocation_id) id: vec3u) { add_yuv_product(id, 0u, true); }

@compute @workgroup_size(16, 16)
fn store_yuv_second_1(@builtin(global_invocation_id) id: vec3u) { store_yuv_product(id, 1u, 1u); }
@compute @workgroup_size(16, 16)
fn add_yuv_second_1(@builtin(global_invocation_id) id: vec3u) { add_yuv_product(id, 1u, false); }
@compute @workgroup_size(16, 16)
fn store_yuv_third_1(@builtin(global_invocation_id) id: vec3u) { store_yuv_product(id, 1u, 2u); }
@compute @workgroup_size(16, 16)
fn finish_yuv_1(@builtin(global_invocation_id) id: vec3u) { add_yuv_product(id, 1u, true); }

@compute @workgroup_size(16, 16)
fn store_yuv_second_2(@builtin(global_invocation_id) id: vec3u) { store_yuv_product(id, 2u, 1u); }
@compute @workgroup_size(16, 16)
fn add_yuv_second_2(@builtin(global_invocation_id) id: vec3u) { add_yuv_product(id, 2u, false); }
@compute @workgroup_size(16, 16)
fn store_yuv_third_2(@builtin(global_invocation_id) id: vec3u) { store_yuv_product(id, 2u, 2u); }
@compute @workgroup_size(16, 16)
fn finish_yuv_2(@builtin(global_invocation_id) id: vec3u) { add_yuv_product(id, 2u, true); }

fn yuv_bits(source: vec4i) -> vec3u {
  return vec3u(source.xyz) & vec3u(0xffffu);
}

@compute @workgroup_size(16, 16)
fn write_horizontal_yuv(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = yuv_bits(horizontal_yuv[padded_index(i32(x), i32(id.y))]);
  let second = yuv_bits(horizontal_yuv[padded_index(i32(x + 1u), i32(id.y))]);
  pack_pair(first, second, id.y * pairs_per_row + id.x);
}

@compute @workgroup_size(16, 16)
fn write_vertical_yuv(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = yuv_bits(vertical_yuv[padded_index(i32(x), i32(id.y))]);
  let second = yuv_bits(vertical_yuv[padded_index(i32(x + 1u), i32(id.y))]);
  pack_pair(first, second, id.y * pairs_per_row + id.x);
}

fn yuv_difference(direction: u32, center: u32, neighbor: u32) -> vec2i {
  let a = yuv_at(direction, center);
  let b = yuv_at(direction, neighbor);
  return vec2i(abs(a.x - b.x), square_wrapped(a.y - b.y) + square_wrapped(a.z - b.z));
}

fn increment_homogeneity(direction: u32, index: u32) {
  if direction == 0u { atomicAdd(&horizontal_homogeneity[index], 1u); }
  else { atomicAdd(&vertical_homogeneity[index], 1u); }
}

@compute @workgroup_size(16, 16)
fn evaluate_homogeneity(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  let offsets = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));
  var differences: array<vec2i, 8>;
  for (var direction = 0u; direction < 2u; direction += 1u) {
    for (var neighbor = 0u; neighbor < 4u; neighbor += 1u) {
      let delta = offsets[neighbor];
      differences[direction * 4u + neighbor] = yuv_difference(
        direction, index, padded_offset(index, delta.x, delta.y));
    }
  }
  let y_threshold = min(max(differences[0].x, differences[1].x),
                        max(differences[6].x, differences[7].x));
  let uv_threshold = min(max(differences[0].y, differences[1].y),
                         max(differences[6].y, differences[7].y));
  for (var direction = 0u; direction < 2u; direction += 1u) {
    for (var neighbor = 0u; neighbor < 4u; neighbor += 1u) {
      let difference = differences[direction * 4u + neighbor];
      if difference.x <= y_threshold && difference.y <= uv_threshold {
        let delta = offsets[neighbor];
        increment_homogeneity(direction, padded_offset(index, delta.x, delta.y));
        if neighbor / 2u == direction {
          for (var distance = 2; distance < 4; distance += 1) {
            let farther = padded_offset(index, delta.x * distance, delta.y * distance);
            let farther_difference = yuv_difference(direction, index, farther);
            if farther_difference.x < y_threshold && farther_difference.y < uv_threshold {
              increment_homogeneity(direction, farther);
            } else { break; }
          }
        }
      }
    }
  }
}

fn homogeneity_at(direction: u32, index: u32) -> u32 {
  return select(atomicLoad(&vertical_homogeneity[index]),
                atomicLoad(&horizontal_homogeneity[index]), direction == 0u);
}

@compute @workgroup_size(16, 16)
fn write_horizontal_homogeneity(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = homogeneity_at(0u, padded_index(i32(x), i32(id.y)));
  let second = homogeneity_at(0u, padded_index(i32(x + 1u), i32(id.y)));
  pack_pair(vec3u(first), vec3u(second), id.y * pairs_per_row + id.x);
}

@compute @workgroup_size(16, 16)
fn write_vertical_homogeneity(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = homogeneity_at(1u, padded_index(i32(x), i32(id.y)));
  let second = homogeneity_at(1u, padded_index(i32(x + 1u), i32(id.y)));
  pack_pair(vec3u(first), vec3u(second), id.y * pairs_per_row + id.x);
}

fn homogeneity_sum(direction: u32, index: u32) -> u32 {
  var result = 0u;
  for (var dy = -1; dy <= 1; dy += 1) {
    for (var dx = -1; dx <= 1; dx += 1) {
      let neighbor = padded_offset(index, dx, dy);
      result += select(atomicLoad(&vertical_homogeneity[neighbor]),
                       atomicLoad(&horizontal_homogeneity[neighbor]), direction == 0u);
    }
  }
  return result;
}

fn second_derivative(direction: u32, index: u32, dx: i32, dy: i32) -> i32 {
  let center = yuv_at(direction, index);
  let before = yuv_at(direction, padded_offset(index, -dx, -dy));
  let after = yuv_at(direction, padded_offset(index, dx, dy));
  return square_wrapped(2 * center.x - before.x - after.x) +
    square_wrapped(2 * center.y - before.y - after.y) +
    square_wrapped(2 * center.z - before.z - after.z);
}

@compute @workgroup_size(16, 16)
fn choose_direction(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  let horizontal_count = homogeneity_sum(0u, index);
  let vertical_count = homogeneity_sum(1u, index);
  var direction = 0u;
  if horizontal_count != vertical_count {
    direction = select(HOR | 1u, VER | 1u, vertical_count > horizontal_count);
  } else {
    let vertical_gradient = second_derivative(1u, index, 0, 1) +
      second_derivative(1u, padded_offset(index, 0, -1), 0, 1) / 2 +
      second_derivative(1u, padded_offset(index, 0, 1), 0, 1) / 2;
    let horizontal_gradient = second_derivative(0u, index, 1, 0) +
      second_derivative(0u, padded_offset(index, -1, 0), 1, 0) / 2 +
      second_derivative(0u, padded_offset(index, 1, 0), 1, 0) / 2;
    direction = select(VER, HOR, vertical_gradient > horizontal_gradient);
  }
  directions[index] = (directions[index] & HOT) | direction;
}

fn refined_direction(index: u32, require_coding_neighbor: bool) -> u32 {
  let north = directions[padded_offset(index, 0, -1)];
  let south = directions[padded_offset(index, 0, 1)];
  let west = directions[padded_offset(index, -1, 0)];
  let east = directions[padded_offset(index, 1, 0)];
  let vertical_count = ((north & VER) + (south & VER) + (west & VER) + (east & VER)) / VER;
  let horizontal_count = ((north & HOR) + (south & HOR) + (west & HOR) + (east & HOR)) / HOR;
  var value = directions[index];
  let coding_neighbor = select((west & HOR) != 0u || (east & HOR) != 0u,
                               (north & VER) != 0u || (south & VER) != 0u,
                               (value & VER) != 0u);
  let threshold = select(3u, 2u, require_coding_neighbor);
  if (value & VER) != 0u && horizontal_count > threshold && (!require_coding_neighbor || !coding_neighbor) {
    value = (value & ~VER) | HOR;
  }
  if (value & HOR) != 0u && vertical_count > threshold && (!require_coding_neighbor || !coding_neighbor) {
    value = (value & ~HOR) | VER;
  }
  return value;
}

@compute @workgroup_size(16, 16)
fn refine_checker_even(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) || ((origin_x() + id.x) & 1u) != ((origin_y() + id.y) & 1u) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  directions[index] = refined_direction(index, true);
}

@compute @workgroup_size(16, 16)
fn refine_checker_odd(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) || ((origin_x() + id.x) & 1u) == ((origin_y() + id.y) & 1u) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  directions[index] = refined_direction(index, true);
}

@compute @workgroup_size(16, 16)
fn load_tiled_direction_plane(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let global_index = image_index(id.x, id.y);
  let direction = (refined_direction_plane[global_index / 8u] >>
    ((global_index & 7u) * 4u)) & 15u;
  directions[padded_index(i32(id.x), i32(id.y))] = direction;
}

@compute @workgroup_size(16, 16)
fn refine_isolated(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  var value = directions[index];
  if (value & 1u) == 0u { value = refined_direction(index, false); }
  atomicStore(&horizontal_homogeneity[index], value);
}

@compute @workgroup_size(16, 16)
fn copy_refined_directions(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  directions[index] = atomicLoad(&horizontal_homogeneity[index]);
}

@compute @workgroup_size(16, 16)
fn combine(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  var selected = select(horizontal_rgb[index], vertical_rgb[index],
                        (directions[index] & VER) != 0u);
  if (directions[index] & HOT) != 0u {
    let channel = cfa_color(id.x, id.y);
    selected[channel] = scaled_sample(id.x, id.y);
  }
  horizontal_rgb[index] = selected;
}

fn pack_pair(first: vec3u, second: vec3u, pair: u32) {
  let word = pair * 3u;
  output[word] = first.x | (first.y << 16u);
  output[word + 1u] = first.z | (second.x << 16u);
  output[word + 2u] = second.y | (second.z << 16u);
}

fn core_position(id: vec3u) -> vec2u {
  return vec2u(core_x() + id.x * 2u, core_y() + id.y);
}

fn in_core_pairs(id: vec3u) -> bool {
  return id.x < core_width() / 2u && id.y < core_height();
}

@compute @workgroup_size(16, 16)
fn write_horizontal(@builtin(global_invocation_id) id: vec3u) {
  if !in_core_pairs(id) { return; }
  let position = core_position(id);
  let first = horizontal_rgb[padded_index(i32(position.x), i32(position.y))].xyz;
  let second = horizontal_rgb[padded_index(i32(position.x + 1u), i32(position.y))].xyz;
  pack_pair(first, second, id.y * (core_width() / 2u) + id.x);
}

@compute @workgroup_size(16, 16)
fn write_vertical(@builtin(global_invocation_id) id: vec3u) {
  if !in_core_pairs(id) { return; }
  let position = core_position(id);
  let first = vertical_rgb[padded_index(i32(position.x), i32(position.y))].xyz;
  let second = vertical_rgb[padded_index(i32(position.x + 1u), i32(position.y))].xyz;
  pack_pair(first, second, id.y * (core_width() / 2u) + id.x);
}

@compute @workgroup_size(16, 16)
fn write_directions(@builtin(global_invocation_id) id: vec3u) {
  if !in_core_pairs(id) { return; }
  let position = core_position(id);
  let first = directions[padded_index(i32(position.x), i32(position.y))] & 15u;
  let second = directions[padded_index(i32(position.x + 1u), i32(position.y))] & 15u;
  pack_pair(vec3u(first), vec3u(second), id.y * (core_width() / 2u) + id.x);
}

@compute @workgroup_size(16, 16)
fn write_direction_plane(@builtin(global_invocation_id) id: vec3u) {
  if !in_core_pairs(id) { return; }
  let position = core_position(id);
  let first = directions[padded_index(i32(position.x), i32(position.y))] & 15u;
  let second = directions[padded_index(i32(position.x + 1u), i32(position.y))] & 15u;
  output[id.y * (core_width() / 2u) + id.x] = first | (second << 16u);
}

@compute @workgroup_size(16, 16)
fn load_direction_plane(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  directions[padded_index(i32(id.x), i32(id.y))] =
    sensor_sample(image_index(id.x, id.y));
}

@compute @workgroup_size(16, 16)
fn write_aahd(@builtin(global_invocation_id) id: vec3u) {
  if !in_core_pairs(id) { return; }
  let position = core_position(id);
  let first = horizontal_rgb[padded_index(i32(position.x), i32(position.y))].xyz;
  let second = horizontal_rgb[padded_index(i32(position.x + 1u), i32(position.y))].xyz;
  pack_pair(first, second, id.y * (core_width() / 2u) + id.x);
}

@compute @workgroup_size(16, 16)
fn blend_highlights(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  let source = horizontal_rgb[index].xyz;
  let clip = highlight_clip();
  if all(source <= vec3u(clip)) { return; }
  let clipped = min(source, vec3u(clip));
  let source_lab = vec3f(
    f32(i32(source.x) + i32(source.y) + i32(source.z)),
    f32(i32(1.7320508 * f32(source.x)) + i32(-1.7320508 * f32(source.y))),
    f32(-i32(source.x) - i32(source.y) + 2 * i32(source.z)));
  let clipped_lab = vec3f(
    f32(i32(clipped.x) + i32(clipped.y) + i32(clipped.z)),
    f32(i32(1.7320508 * f32(clipped.x)) + i32(-1.7320508 * f32(clipped.y))),
    f32(-i32(clipped.x) - i32(clipped.y) + 2 * i32(clipped.z)));
  let source_chroma = source_lab.y * source_lab.y + source_lab.z * source_lab.z;
  let clipped_chroma = clipped_lab.y * clipped_lab.y + clipped_lab.z * clipped_lab.z;
  let ratio = sqrt(clipped_chroma / source_chroma);
  let lab = vec3f(source_lab.x, source_lab.y * ratio, source_lab.z * ratio);
  let restored = vec3f(
    lab.x + 0.8660254 * lab.y - 0.5 * lab.z,
    lab.x - 0.8660254 * lab.y - 0.5 * lab.z,
    lab.x + lab.z) / 3.0;
  horizontal_rgb[index] = vec4u(vec3u(restored), 0u);
}

fn highlight_clip() -> u32 {
  return u32(min(65535.0 * parameter(16), min(65535.0 * parameter(17), 65535.0 * parameter(18))));
}

@compute @workgroup_size(16, 16)
fn collect_highlights(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= core_width() || id.y >= core_height() { return; }
  let x = core_x() + id.x;
  let y = core_y() + id.y;
  let source = horizontal_rgb[padded_index(i32(x), i32(y))].xyz;
  if all(source <= vec3u(highlight_clip())) { return; }
  let record = atomicAdd(&highlight_count, 1u);
  let base = record * 4u;
  if base + 3u >= arrayLength(&output) { return; }
  output[base] = local_image_index(x, y);
  output[base + 1u] = source.x;
  output[base + 2u] = source.y;
  output[base + 3u] = source.z;
}

@compute @workgroup_size(1)
fn apply_highlights(@builtin(global_invocation_id) id: vec3u) {
  let record = id.y * LINEAR_DISPATCH_WIDTH + id.x;
  if record >= parameters[63] { return; }
  let base = record * 4u;
  let source = output[base];
  let x = source % width();
  let y = source / width();
  horizontal_rgb[padded_index(i32(x), i32(y))] = vec4u(
    output[base + 1u], output[base + 2u], output[base + 3u], 0u);
}

fn prophoto(rgb: vec3u) -> vec3u {
  let source = vec3f(rgb);
  return vec3u(vec3i(
    clamp(i32(parameter(32) * source.x + parameter(33) * source.y + parameter(34) * source.z), 0, 65535),
    clamp(i32(parameter(36) * source.x + parameter(37) * source.y + parameter(38) * source.z), 0, 65535),
    clamp(i32(parameter(40) * source.x + parameter(41) * source.y + parameter(42) * source.z), 0, 65535)));
}

@compute @workgroup_size(16, 16)
fn write_final(@builtin(global_invocation_id) id: vec3u) {
  if !in_core_pairs(id) { return; }
  let position = core_position(id);
  let first = prophoto(horizontal_rgb[padded_index(i32(position.x), i32(position.y))].xyz);
  let second = prophoto(horizontal_rgb[padded_index(i32(position.x + 1u), i32(position.y))].xyz);
  pack_pair(first, second, id.y * (core_width() / 2u) + id.x);
}
