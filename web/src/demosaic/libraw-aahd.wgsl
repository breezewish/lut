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

const MARGIN: u32 = 4u;
const HOR: u32 = 2u;
const VER: u32 = 4u;
const HOT: u32 = 8u;

fn width() -> u32 { return parameters[0]; }
fn height() -> u32 { return parameters[1]; }
fn padded_width() -> u32 { return parameters[2]; }
fn padded_height() -> u32 { return parameters[3]; }
fn parameter(index: u32) -> f32 { return bitcast<f32>(parameters[index]); }
fn image_index(x: u32, y: u32) -> u32 { return y * width() + x; }
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
  let channel = parameters[48u + (y & 1u) * 2u + (x & 1u)];
  return select(channel, 1u, channel == 3u);
}

fn sensor_sample(index: u32) -> u32 {
  let word = mosaic[index / 2u];
  return select(word >> 16u, word & 0xffffu, index % 2u == 0u);
}

fn scaled_sample(x: u32, y: u32) -> u32 {
  let channel = cfa_color(x, y);
  let value = max(f32(sensor_sample(image_index(x, y))) - parameter(8u + channel), 0.0);
  return u32(clamp(value * parameter(12u + channel), 0.0, 65535.0));
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
fn initialize(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
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
  let row_color = cfa_color(id.x ^ 1u, id.y);
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
  let horizontal = abs(west2 - east2) + abs(west_cross - east_cross) +
    abs(west_cross - east_cross + east2 - west2);
  let vertical = abs(north2 - south2) + abs(north_cross - south_cross) +
    abs(north_cross - south_cross + south2 - north2);
  let dx = select(0, -1, vertical > horizontal);
  let dy = select(-1, 0, vertical > horizontal);
  let replacement = (rgb_channel(0u, padded_offset(index, 2 * dx, 2 * dy), known) +
    rgb_channel(0u, padded_offset(index, -2 * dx, -2 * dy), known)) / 2;
  set_rgb_channel(0u, index, known, replacement);
  set_rgb_channel(1u, index, known, replacement);
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
  let row_color = cfa_color(id.x ^ 1u, id.y);
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
  let row_color = select(site_color, cfa_color(id.x ^ 1u, id.y), site_color == 1u);
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

fn refine_direction(index: u32, require_coding_neighbor: bool) {
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
  directions[index] = value;
}

@compute @workgroup_size(16, 16)
fn refine_checker_even(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) || (id.x & 1u) != (id.y & 1u) { return; }
  refine_direction(padded_index(i32(id.x), i32(id.y)), true);
}

@compute @workgroup_size(16, 16)
fn refine_checker_odd(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) || (id.x & 1u) == (id.y & 1u) { return; }
  refine_direction(padded_index(i32(id.x), i32(id.y)), true);
}

@compute @workgroup_size(16, 16)
fn refine_isolated(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  if (directions[index] & 1u) == 0u { refine_direction(index, false); }
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

@compute @workgroup_size(16, 16)
fn write_horizontal(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = horizontal_rgb[padded_index(i32(x), i32(id.y))].xyz;
  let second = horizontal_rgb[padded_index(i32(x + 1u), i32(id.y))].xyz;
  pack_pair(first, second, id.y * pairs_per_row + id.x);
}

@compute @workgroup_size(16, 16)
fn write_vertical(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = vertical_rgb[padded_index(i32(x), i32(id.y))].xyz;
  let second = vertical_rgb[padded_index(i32(x + 1u), i32(id.y))].xyz;
  pack_pair(first, second, id.y * pairs_per_row + id.x);
}

@compute @workgroup_size(16, 16)
fn write_directions(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = directions[padded_index(i32(x), i32(id.y))] & 15u;
  let second = directions[padded_index(i32(x + 1u), i32(id.y))] & 15u;
  pack_pair(vec3u(first), vec3u(second), id.y * pairs_per_row + id.x);
}

@compute @workgroup_size(16, 16)
fn write_aahd(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = horizontal_rgb[padded_index(i32(x), i32(id.y))].xyz;
  let second = horizontal_rgb[padded_index(i32(x + 1u), i32(id.y))].xyz;
  pack_pair(first, second, id.y * pairs_per_row + id.x);
}

@compute @workgroup_size(16, 16)
fn blend_highlights(@builtin(global_invocation_id) id: vec3u) {
  if !in_image(id) { return; }
  let index = padded_index(i32(id.x), i32(id.y));
  let source = horizontal_rgb[index].xyz;
  let clip = u32(min(65535.0 * parameter(16), min(65535.0 * parameter(17), 65535.0 * parameter(18))));
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

fn prophoto(rgb: vec3u) -> vec3u {
  let source = vec3f(rgb);
  return vec3u(vec3i(
    clamp(i32(parameter(32) * source.x + parameter(33) * source.y + parameter(34) * source.z), 0, 65535),
    clamp(i32(parameter(36) * source.x + parameter(37) * source.y + parameter(38) * source.z), 0, 65535),
    clamp(i32(parameter(40) * source.x + parameter(41) * source.y + parameter(42) * source.z), 0, 65535)));
}

@compute @workgroup_size(16, 16)
fn write_final(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let x = id.x * 2u;
  let first = prophoto(horizontal_rgb[padded_index(i32(x), i32(id.y))].xyz);
  let second = prophoto(horizontal_rgb[padded_index(i32(x + 1u), i32(id.y))].xyz);
  pack_pair(first, second, id.y * pairs_per_row + id.x);
}
