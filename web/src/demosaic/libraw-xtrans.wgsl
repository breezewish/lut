@group(0) @binding(0) var<storage, read_write> mosaic: array<u32>;
@group(0) @binding(1) var<storage, read_write> candidates: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> lab_values: array<vec4i>;
@group(0) @binding(3) var<storage, read_write> derivatives: array<f32>;
@group(0) @binding(4) var<storage, read_write> homogeneity: array<u32>;
@group(0) @binding(5) var<storage, read_write> chosen_rgb: array<vec4u>;
@group(0) @binding(6) var<storage, read_write> output: array<u32>;
@group(0) @binding(7) var<storage, read> parameters: array<u32>;
@group(0) @binding(8) var<storage, read> cbrt_lut: array<f32>;
@group(0) @binding(9) var<storage, read_write> overlap_band_a: array<vec4u>;
@group(0) @binding(10) var<storage, read_write> overlap_band_b: array<vec4u>;
@group(0) @binding(11) var<storage, read_write> overlap_right: array<vec4u>;
@group(0) @binding(12) var<storage, read_write> lab_terms: array<vec4f>;

const TILE_SIZE: u32 = 512u;
const TILE_PIXELS: u32 = TILE_SIZE * TILE_SIZE;
const LINEAR_DISPATCH_WIDTH: u32 = 65535u;

fn global_width() -> u32 { return parameters[0]; }
fn global_height() -> u32 { return parameters[1]; }
fn input_x() -> u32 { return parameters[2]; }
fn input_y() -> u32 { return parameters[3]; }
fn input_width() -> u32 { return parameters[4]; }
fn input_height() -> u32 { return parameters[5]; }
fn output_x() -> u32 { return parameters[6]; }
fn output_y() -> u32 { return parameters[7]; }
fn output_width() -> u32 { return parameters[8]; }
fn output_height() -> u32 { return parameters[9]; }
fn solitary_green_row() -> u32 { return parameters[10]; }
fn solitary_green_column() -> u32 { return parameters[11]; }
fn band_index() -> u32 { return parameters[13]; }
fn write_demosaic_only() -> bool { return parameters[14] != 0u; }
fn parameter(index: u32) -> f32 { return bitcast<f32>(parameters[index]); }

fn modulo(value: i32, divisor: i32) -> u32 {
  return u32(((value % divisor) + divisor) % divisor);
}

fn cfa_color(x: i32, y: i32) -> u32 {
  return parameters[64u + modulo(y, 6) * 6u + modulo(x, 6)];
}

fn packed_sample(index: u32) -> u32 {
  let word = mosaic[index / 2u];
  return select(word >> 16u, word & 0xffffu, index % 2u == 0u);
}

fn scaled_sample(x: i32, y: i32) -> u32 {
  return packed_sample(u32(y) * global_width() + u32(x));
}

fn tile_index(x: u32, y: u32) -> u32 { return y * TILE_SIZE + x; }
fn candidate_index(direction: u32, x: u32, y: u32) -> u32 {
  return direction * TILE_PIXELS + tile_index(x, y);
}
fn candidate(direction: u32, x: i32, y: i32) -> vec4u {
  return candidates[candidate_index(direction, u32(x), u32(y))];
}
fn set_candidate_channel(direction: u32, x: u32, y: u32, channel: u32, value: u32) {
  let index = candidate_index(direction, x, y);
  var rgb = candidates[index];
  rgb[channel] = value;
  candidates[index] = rgb;
}

fn hex_delta(global_x: u32, global_y: u32, neighbor: u32) -> vec2i {
  let phase = (global_y % 3u) * 3u + global_x % 3u;
  let base = 100u + (phase * 8u + neighbor) * 2u;
  return vec2i(bitcast<i32>(parameters[base]), bitcast<i32>(parameters[base + 1u]));
}

fn in_input(id: vec3u) -> bool {
  return id.x < input_width() && id.y < input_height();
}

fn in_local_margin(id: vec3u, margin: u32) -> bool {
  return id.x >= margin && id.y >= margin &&
    id.x + margin < input_width() && id.y + margin < input_height();
}

fn native_rgb(global_x: i32, global_y: i32) -> vec4u {
  let color = cfa_color(global_x, global_y);
  var rgb = vec4u(0u);
  rgb[color] = scaled_sample(global_x, global_y);
  return rgb;
}

fn has_previous_rgb(global_x: u32, global_y: u32) -> bool {
  return (output_y() != 0u && global_y < output_y()) ||
    (output_x() != 0u && global_x < output_x() &&
      global_y >= output_y() && global_y < output_y() + output_height());
}

fn previous_rgb(global_x: u32, global_y: u32) -> vec4u {
  if output_y() != 0u && global_y < output_y() {
    let row = global_y - (output_y() - 8u);
    let index = row * global_width() + global_x;
    if band_index() % 2u == 0u {
      return overlap_band_a[index];
    }
    return overlap_band_b[index];
  }
  if output_x() != 0u && global_x < output_x() &&
      global_y >= output_y() && global_y < output_y() + output_height() {
    return overlap_right[(global_y - output_y()) * 8u + global_x - (output_x() - 8u)];
  }
  return vec4u(0u);
}

fn initial_rgb(global_x: u32, global_y: u32) -> vec4u {
  if has_previous_rgb(global_x, global_y) {
    return previous_rgb(global_x, global_y);
  }
  return native_rgb(i32(global_x), i32(global_y));
}

fn clip_u16(value: i32) -> u32 { return u32(clamp(value, 0, 65535)); }

// LibRaw is compiled with floating-point contraction disabled. Keeping every
// product and sum as observable bits prevents a fused GPU operation from
// changing a CIELab derivative and selecting another Markesteijn candidate.
fn rounded_product(left: f32, right: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(left * right));
}

fn rounded_sum(left: f32, right: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(left + right));
}

@compute @workgroup_size(256)
fn scale_mosaic(@builtin(global_invocation_id) id: vec3u) {
  let word_index = id.y * LINEAR_DISPATCH_WIDTH * 256u + id.x;
  let sample_count = global_width() * global_height();
  let first_index = word_index * 2u;
  if first_index >= sample_count { return; }
  let word = mosaic[word_index];
  let first_x = first_index % global_width();
  let first_y = first_index / global_width();
  let first_channel = cfa_color(i32(first_x), i32(first_y));
  let first = u32(clamp(
    max(f32(word & 0xffffu) - parameter(16u + first_channel), 0.0) *
      parameter(20u + first_channel),
    0.0, 65535.0));
  var second = 0u;
  if first_index + 1u < sample_count {
    let second_index = first_index + 1u;
    let second_x = second_index % global_width();
    let second_y = second_index / global_width();
    let second_channel = cfa_color(i32(second_x), i32(second_y));
    second = u32(clamp(
      max(f32(word >> 16u) - parameter(16u + second_channel), 0.0) *
        parameter(20u + second_channel),
      0.0, 65535.0));
  }
  mosaic[word_index] = first | (second << 16u);
}

@compute @workgroup_size(16, 16)
fn initialize_candidates(@builtin(global_invocation_id) id: vec3u) {
  if !in_input(id) { return; }
  let gx = i32(input_x() + id.x);
  let gy = i32(input_y() + id.y);
  let color = cfa_color(gx, gy);
  let value = scaled_sample(gx, gy);
  var base = initial_rgb(u32(gx), u32(gy));
  base[color] = value;
  if color == 1u {
    for (var direction = 0u; direction < 4u; direction += 1u) {
      candidates[candidate_index(direction, id.x, id.y)] = base;
    }
    return;
  }

  var green_min = 65535u;
  var green_max = 0u;
  for (var neighbor = 0u; neighbor < 6u; neighbor += 1u) {
    let delta = hex_delta(u32(gx), u32(gy), neighbor);
    let green = scaled_sample(gx + delta.x, gy + delta.y);
    green_min = min(green_min, green);
    green_max = max(green_max, green);
  }
  if has_previous_rgb(u32(gx), u32(gy)) {
    green_min = previous_rgb(u32(gx), u32(gy)).y;
  }
  base.y = green_min;
  for (var direction = 0u; direction < 4u; direction += 1u) {
    candidates[candidate_index(direction, id.x, id.y)] = base;
  }

  let h0 = hex_delta(u32(gx), u32(gy), 0u);
  let h1 = hex_delta(u32(gx), u32(gy), 1u);
  let h2 = hex_delta(u32(gx), u32(gy), 2u);
  let h3 = hex_delta(u32(gx), u32(gy), 3u);
  let h4 = hex_delta(u32(gx), u32(gy), 4u);
  let h5 = hex_delta(u32(gx), u32(gy), 5u);
  var interpolation: array<i32, 4>;
  interpolation[0] = 174 * i32(scaled_sample(gx + h1.x, gy + h1.y) +
      scaled_sample(gx + h0.x, gy + h0.y)) -
    46 * i32(scaled_sample(gx + h1.x * 2, gy + h1.y * 2) +
      scaled_sample(gx + h0.x * 2, gy + h0.y * 2));
  interpolation[1] = 223 * i32(scaled_sample(gx + h3.x, gy + h3.y)) +
    33 * i32(scaled_sample(gx + h2.x, gy + h2.y)) +
    92 * (i32(value) - i32(scaled_sample(gx - h2.x, gy - h2.y)));
  interpolation[2] = 164 * i32(scaled_sample(gx + h4.x, gy + h4.y)) +
    92 * i32(scaled_sample(gx - h4.x * 2, gy - h4.y * 2)) +
    33 * (2 * i32(value) - i32(scaled_sample(gx + h4.x * 3, gy + h4.y * 3)) -
      i32(scaled_sample(gx - h4.x * 3, gy - h4.y * 3)));
  interpolation[3] = 164 * i32(scaled_sample(gx + h5.x, gy + h5.y)) +
    92 * i32(scaled_sample(gx - h5.x * 2, gy - h5.y * 2)) +
    33 * (2 * i32(value) - i32(scaled_sample(gx + h5.x * 3, gy + h5.y * 3)) -
      i32(scaled_sample(gx - h5.x * 3, gy - h5.y * 3)));
  let phase = select(0u, 1u, modulo(gy - i32(solitary_green_row()), 3) == 0u);
  for (var direction = 0u; direction < 4u; direction += 1u) {
    set_candidate_channel(
      direction ^ phase,
      id.x,
      id.y,
      1u,
      u32(clamp(interpolation[direction] >> 8, i32(green_min), i32(green_max))),
    );
  }
}

fn interpolate_solitary(id: vec3u, base_direction: u32) {
  if !in_local_margin(id, 2u) { return; }
  let gx = i32(input_x() + id.x);
  let gy = i32(input_y() + id.y);
  if cfa_color(gx, gy) != 1u ||
      modulo(gy - i32(solitary_green_row()), 3) != 0u ||
      modulo(gx - i32(solitary_green_column()), 3) != 0u { return; }

  var colors: array<vec2i, 6>;
  var differences: array<f32, 6>;
  let initial_color = cfa_color(gx + 1, gy);
  for (var direction = 0u; direction < 6u; direction += 1u) {
    let source_offsets = array<u32, 6>(0u, 1u, 2u, 2u, 3u, 3u);
    let source_direction = base_direction + source_offsets[direction];
    let axis = select(vec2i(0, 1), vec2i(1, 0), direction % 2u == 0u);
    let center = candidate(source_direction, i32(id.x), i32(id.y));
    var difference = 0.0;
    var result = vec2i(0);
    for (var distance = 1; distance <= 2; distance += 1) {
      let delta = axis * distance;
      let positive = candidate(source_direction, i32(id.x) + delta.x, i32(id.y) + delta.y);
      let negative = candidate(source_direction, i32(id.x) - delta.x, i32(id.y) - delta.y);
      let green = 2 * i32(center.y) - i32(positive.y) - i32(negative.y);
      let channel = initial_color ^ ((direction & 1u) * 2u) ^ (u32(distance - 1) * 2u);
      result[channel / 2u] = green + i32(positive[channel]) + i32(negative[channel]);
      if direction > 1u {
        let channel_delta = i32(positive.y) - i32(negative.y) -
          i32(positive[channel]) + i32(negative[channel]);
        difference += f32(channel_delta) * f32(channel_delta) +
          f32(green) * f32(green);
      }
    }
    colors[direction] = result;
    differences[direction] = difference;
  }

  let selections = array<u32, 4>(
    0u,
    1u,
    select(3u, 2u, differences[2] < differences[3]),
    select(5u, 4u, differences[4] < differences[5]),
  );
  for (var candidate_offset = 0u; candidate_offset < 4u; candidate_offset += 1u) {
    let values = colors[selections[candidate_offset]] / 2;
    let direction = base_direction + candidate_offset;
    set_candidate_channel(direction, id.x, id.y, 0u, clip_u16(values.x));
    set_candidate_channel(direction, id.x, id.y, 2u, clip_u16(values.y));
  }
}

fn interpolate_cross(id: vec3u, base_direction: u32) {
  if !in_local_margin(id, 3u) { return; }
  let gx = i32(input_x() + id.x);
  let gy = i32(input_y() + id.y);
  let missing = 2i - i32(cfa_color(gx, gy));
  if missing == 1 { return; }
  let vertical = modulo(gy - i32(solitary_green_row()), 3) != 0u;
  let close_axis = select(vec2i(1, 0), vec2i(0, 1), vertical);
  let far_axis = select(vec2i(0, 3), vec2i(3, 0), vertical);
  for (var offset = 0u; offset < 4u; offset += 1u) {
    let direction = base_direction + offset;
    let center = candidate(direction, i32(id.x), i32(id.y));
    let close_positive = candidate(direction, i32(id.x) + close_axis.x, i32(id.y) + close_axis.y);
    let close_negative = candidate(direction, i32(id.x) - close_axis.x, i32(id.y) - close_axis.y);
    let far_positive = candidate(direction, i32(id.x) + far_axis.x, i32(id.y) + far_axis.y);
    let far_negative = candidate(direction, i32(id.x) - far_axis.x, i32(id.y) - far_axis.y);
    let close_gradient = abs(i32(center.y) - i32(close_positive.y)) +
      abs(i32(center.y) - i32(close_negative.y));
    let far_gradient = abs(i32(center.y) - i32(far_positive.y)) +
      abs(i32(center.y) - i32(far_negative.y));
    let use_close = offset > 1u ||
      ((offset ^ select(1u, 0u, vertical)) & 1u) != 0u ||
      close_gradient < 2 * far_gradient;
    let positive = select(far_positive, close_positive, use_close);
    let negative = select(far_negative, close_negative, use_close);
    let value = (i32(positive[u32(missing)]) + i32(negative[u32(missing)]) +
      2 * i32(center.y) - i32(positive.y) - i32(negative.y)) / 2;
    set_candidate_channel(direction, id.x, id.y, u32(missing), clip_u16(value));
  }
}

fn interpolate_green_blocks(id: vec3u, base_direction: u32) {
  if !in_local_margin(id, 2u) { return; }
  let gx = i32(input_x() + id.x);
  let gy = i32(input_y() + id.y);
  if cfa_color(gx, gy) != 1u ||
      modulo(gy - i32(solitary_green_row()), 3) == 0u ||
      modulo(gx - i32(solitary_green_column()), 3) == 0u { return; }
  for (var offset = 0u; offset < 4u; offset += 1u) {
    let direction = base_direction + offset;
    let first_delta = hex_delta(u32(gx), u32(gy), offset * 2u);
    let second_delta = hex_delta(u32(gx), u32(gy), offset * 2u + 1u);
    let center = candidate(direction, i32(id.x), i32(id.y));
    let first = candidate(direction, i32(id.x) + first_delta.x, i32(id.y) + first_delta.y);
    let second = candidate(direction, i32(id.x) + second_delta.x, i32(id.y) + second_delta.y);
    if any(first_delta + second_delta != vec2i(0)) {
      let green = 3 * i32(center.y) - 2 * i32(first.y) - i32(second.y);
      set_candidate_channel(direction, id.x, id.y, 0u,
        clip_u16((green + 2 * i32(first.x) + i32(second.x)) / 3));
      set_candidate_channel(direction, id.x, id.y, 2u,
        clip_u16((green + 2 * i32(first.z) + i32(second.z)) / 3));
    } else {
      let green = 2 * i32(center.y) - i32(first.y) - i32(second.y);
      set_candidate_channel(direction, id.x, id.y, 0u,
        clip_u16((green + i32(first.x) + i32(second.x)) / 2));
      set_candidate_channel(direction, id.x, id.y, 2u,
        clip_u16((green + i32(first.z) + i32(second.z)) / 2));
    }
  }
}

@compute @workgroup_size(16, 16)
fn interpolate_solitary_first(@builtin(global_invocation_id) id: vec3u) { interpolate_solitary(id, 0u); }
@compute @workgroup_size(16, 16)
fn interpolate_cross_first(@builtin(global_invocation_id) id: vec3u) { interpolate_cross(id, 0u); }
@compute @workgroup_size(16, 16)
fn interpolate_blocks_first(@builtin(global_invocation_id) id: vec3u) { interpolate_green_blocks(id, 0u); }

@compute @workgroup_size(16, 16)
fn copy_candidates(@builtin(global_invocation_id) id: vec3u) {
  if !in_input(id) { return; }
  for (var direction = 0u; direction < 4u; direction += 1u) {
    candidates[candidate_index(direction + 4u, id.x, id.y)] =
      candidates[candidate_index(direction, id.x, id.y)];
  }
}

@compute @workgroup_size(16, 16)
fn recalculate_green(@builtin(global_invocation_id) id: vec3u) {
  if !in_local_margin(id, 2u) { return; }
  let gx = i32(input_x() + id.x);
  let gy = i32(input_y() + id.y);
  let color = cfa_color(gx, gy);
  if color == 1u { return; }
  var minimum = 65535u;
  var maximum = 0u;
  for (var neighbor = 0u; neighbor < 6u; neighbor += 1u) {
    let delta = hex_delta(u32(gx), u32(gy), neighbor);
    let green = scaled_sample(gx + delta.x, gy + delta.y);
    minimum = min(minimum, green);
    maximum = max(maximum, green);
  }
  if has_previous_rgb(u32(gx), u32(gy)) {
    minimum = previous_rgb(u32(gx), u32(gy)).y;
  }
  let phase = select(0u, 1u, modulo(gy - i32(solitary_green_row()), 3) == 0u);
  for (var neighbor = 3u; neighbor < 6u; neighbor += 1u) {
    let direction = 4u + ((neighbor - 2u) ^ phase);
    let delta = hex_delta(u32(gx), u32(gy), neighbor);
    let center = candidate(direction, i32(id.x), i32(id.y));
    let near = candidate(direction, i32(id.x) + delta.x, i32(id.y) + delta.y);
    let far = candidate(direction, i32(id.x) - delta.x * 2, i32(id.y) - delta.y * 2);
    let value = i32(far.y) + 2 * i32(near.y) - i32(far[color]) -
      2 * i32(near[color]) + 3 * i32(center[color]);
    set_candidate_channel(direction, id.x, id.y, 1u,
      u32(clamp(value / 3, i32(minimum), i32(maximum))));
  }
}

@compute @workgroup_size(16, 16)
fn interpolate_solitary_refined(@builtin(global_invocation_id) id: vec3u) { interpolate_solitary(id, 4u); }
@compute @workgroup_size(16, 16)
fn interpolate_cross_refined(@builtin(global_invocation_id) id: vec3u) { interpolate_cross(id, 4u); }
@compute @workgroup_size(16, 16)
fn interpolate_blocks_refined(@builtin(global_invocation_id) id: vec3u) { interpolate_green_blocks(id, 4u); }

fn multiply_lab_term(id: vec3u, channel: u32) {
  if id.z >= 8u || !in_local_margin(id, 2u) { return; }
  let rgb = candidates[candidate_index(id.z, id.x, id.y)];
  let value = f32(rgb[channel]);
  let index = candidate_index(id.z, id.x, id.y);
  lab_terms[index] = vec4f(
    parameter(28u + channel) * value,
    parameter(31u + channel) * value,
    parameter(34u + channel) * value,
    0.0,
  );
}

fn add_lab_term(id: vec3u, first: bool) {
  if id.z >= 8u || !in_local_margin(id, 2u) { return; }
  let index = candidate_index(id.z, id.x, id.y);
  let term = lab_terms[index].xyz;
  var accumulator = vec3f(0.5);
  if !first {
    accumulator = bitcast<vec3f>(lab_values[index].xyz);
  }
  for (var component = 0u; component < 3u; component += 1u) {
    accumulator[component] += term[component];
  }
  lab_values[index] = vec4i(bitcast<vec3i>(accumulator), 0);
}

@compute @workgroup_size(8, 8, 1)
fn multiply_lab_red(@builtin(global_invocation_id) id: vec3u) { multiply_lab_term(id, 0u); }
@compute @workgroup_size(8, 8, 1)
fn add_lab_red(@builtin(global_invocation_id) id: vec3u) { add_lab_term(id, true); }
@compute @workgroup_size(8, 8, 1)
fn multiply_lab_green(@builtin(global_invocation_id) id: vec3u) { multiply_lab_term(id, 1u); }
@compute @workgroup_size(8, 8, 1)
fn add_lab_green(@builtin(global_invocation_id) id: vec3u) { add_lab_term(id, false); }
@compute @workgroup_size(8, 8, 1)
fn multiply_lab_blue(@builtin(global_invocation_id) id: vec3u) { multiply_lab_term(id, 2u); }
@compute @workgroup_size(8, 8, 1)
fn add_lab_blue(@builtin(global_invocation_id) id: vec3u) { add_lab_term(id, false); }

@compute @workgroup_size(8, 8, 1)
fn lookup_lab(@builtin(global_invocation_id) id: vec3u) {
  if id.z >= 8u || !in_local_margin(id, 2u) { return; }
  let index = candidate_index(id.z, id.x, id.y);
  let xyz = bitcast<vec3f>(lab_values[index].xyz);
  lab_terms[index] = vec4f(
    cbrt_lut[u32(clamp(i32(xyz.x), 0, 65535))],
    cbrt_lut[u32(clamp(i32(xyz.y), 0, 65535))],
    cbrt_lut[u32(clamp(i32(xyz.z), 0, 65535))],
    0.0);
}

@compute @workgroup_size(8, 8, 1)
fn build_lab_differences(@builtin(global_invocation_id) id: vec3u) {
  if id.z >= 8u || !in_local_margin(id, 2u) { return; }
  let index = candidate_index(id.z, id.x, id.y);
  let encoded = lab_terms[index].xyz;
  lab_values[index] = vec4i(bitcast<vec3i>(vec3f(
    116.0 * encoded.y,
    encoded.x - encoded.y,
    encoded.y - encoded.z)), 0);
}

@compute @workgroup_size(8, 8, 1)
fn subtract_lab_offset(@builtin(global_invocation_id) id: vec3u) {
  if id.z >= 8u || !in_local_margin(id, 2u) { return; }
  let index = candidate_index(id.z, id.x, id.y);
  var intermediate = bitcast<vec3f>(lab_values[index].xyz);
  intermediate.x -= 16.0;
  lab_values[index] = vec4i(bitcast<vec3i>(intermediate), 0);
}

@compute @workgroup_size(8, 8, 1)
fn finish_lab(@builtin(global_invocation_id) id: vec3u) {
  if id.z >= 8u || !in_local_margin(id, 2u) { return; }
  let index = candidate_index(id.z, id.x, id.y);
  let intermediate = bitcast<vec3f>(lab_values[index].xyz);
  lab_values[index] = vec4i(
    i32(64.0 * intermediate.x),
    i32(32000.0 * intermediate.y),
    i32(12800.0 * intermediate.z),
    0,
  );
}

@compute @workgroup_size(8, 8, 1)
fn differentiate(@builtin(global_invocation_id) id: vec3u) {
  if id.z >= 8u || !in_local_margin(id, 3u) { return; }
  let offsets = array<vec2i, 4>(vec2i(1, 0), vec2i(0, 1), vec2i(1, 1), vec2i(-1, 1));
  let delta = offsets[id.z & 3u];
  let center = lab_values[candidate_index(id.z, id.x, id.y)].xyz;
  let positive = lab_values[candidate_index(id.z, u32(i32(id.x) + delta.x), u32(i32(id.y) + delta.y))].xyz;
  let negative = lab_values[candidate_index(id.z, u32(i32(id.x) - delta.x), u32(i32(id.y) - delta.y))].xyz;
  let green = 2 * center.x - positive.x - negative.x;
  let first = green;
  let second = 2 * center.y - positive.y - negative.y + green * 500 / 232;
  let third = 2 * center.z - positive.z - negative.z - green * 500 / 580;
  derivatives[candidate_index(id.z, id.x, id.y)] =
    f32(first * first + second * second + third * third);
}

@compute @workgroup_size(8, 8, 1)
fn build_homogeneity(@builtin(global_invocation_id) id: vec3u) {
  if id.z >= 8u || !in_input(id) { return; }
  let output_index = candidate_index(id.z, id.x, id.y);
  homogeneity[output_index] = 0u;
  if !in_local_margin(id, 4u) { return; }
  let center_index = candidate_index(0u, id.x, id.y);
  var threshold = derivatives[center_index];
  for (var direction = 1u; direction < 8u; direction += 1u) {
    threshold = min(threshold, derivatives[candidate_index(direction, id.x, id.y)]);
  }
  threshold *= 8.0;
  var count = 0u;
  for (var dy = -1; dy <= 1; dy += 1) {
    for (var dx = -1; dx <= 1; dx += 1) {
      if derivatives[candidate_index(id.z, u32(i32(id.x) + dx), u32(i32(id.y) + dy))] <= threshold {
        count += 1u;
      }
    }
  }
  homogeneity[output_index] = count;
}

fn border_rgb(gx: i32, gy: i32) -> vec4u {
  let center_color = cfa_color(gx, gy);
  var sums = vec4u(0u);
  var counts = vec4u(0u);
  for (var dy = -1; dy <= 1; dy += 1) {
    for (var dx = -1; dx <= 1; dx += 1) {
      let x = gx + dx;
      let y = gy + dy;
      if x < 0 || y < 0 || x >= i32(global_width()) || y >= i32(global_height()) { continue; }
      let color = cfa_color(x, y);
      sums[color] += scaled_sample(x, y);
      counts[color] += 1u;
    }
  }
  var result = native_rgb(gx, gy);
  for (var color = 0u; color < 3u; color += 1u) {
    if color != center_color && counts[color] != 0u {
      result[color] = sums[color] / counts[color];
    }
  }
  return result;
}

@compute @workgroup_size(16, 16)
fn choose_rgb(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= output_width() || id.y >= output_height() { return; }
  let gx = output_x() + id.x;
  let gy = output_y() + id.y;
  let output_index = id.y * output_width() + id.x;
  if gx < 8u || gy < 8u || gx + 8u >= global_width() || gy + 8u >= global_height() {
    chosen_rgb[output_index] = border_rgb(i32(gx), i32(gy));
    return;
  }
  chosen_rgb[output_index] = choose_markesteijn(gx - input_x(), gy - input_y());
}

fn choose_markesteijn(lx: u32, ly: u32) -> vec4u {
  var scores: array<u32, 8>;
  for (var direction = 0u; direction < 8u; direction += 1u) {
    var score = 0u;
    for (var dy = -2; dy <= 2; dy += 1) {
      for (var dx = -2; dx <= 2; dx += 1) {
        score += homogeneity[candidate_index(direction, u32(i32(lx) + dx), u32(i32(ly) + dy))];
      }
    }
    scores[direction] = score;
  }
  for (var direction = 0u; direction < 4u; direction += 1u) {
    if scores[direction] < scores[direction + 4u] {
      scores[direction] = 0u;
    } else if scores[direction] > scores[direction + 4u] {
      scores[direction + 4u] = 0u;
    }
  }
  var maximum = scores[0];
  for (var direction = 1u; direction < 8u; direction += 1u) {
    maximum = max(maximum, scores[direction]);
  }
  let threshold = maximum - (maximum >> 3u);
  var sum = vec3u(0u);
  var count = 0u;
  for (var direction = 0u; direction < 8u; direction += 1u) {
    if scores[direction] >= threshold {
      sum += candidates[candidate_index(direction, lx, ly)].xyz;
      count += 1u;
    }
  }
  return vec4u(sum / count, 0u);
}

fn tile_initial_rgb(gx: i32, gy: i32) -> vec4u {
  let color = cfa_color(gx, gy);
  var rgb = native_rgb(gx, gy);
  if color != 1u {
    var minimum = 65535u;
    for (var neighbor = 0u; neighbor < 6u; neighbor += 1u) {
      let delta = hex_delta(u32(gx), u32(gy), neighbor);
      minimum = min(minimum, scaled_sample(gx + delta.x, gy + delta.y));
    }
    rgb.y = minimum;
  }
  return rgb;
}

@compute @workgroup_size(16, 16)
fn save_overlap(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= output_width() || id.y >= output_height() { return; }
  var rgb = chosen_rgb[id.y * output_width() + id.x];
  let gx = i32(output_x() + id.x);
  let gy = i32(output_y() + id.y);
  let is_final_border = gx < 8 || gy < 8 ||
    gx + 8 >= i32(global_width()) || gy + 8 >= i32(global_height());
  if is_final_border {
    let has_tile_result = gx >= 6 && gy >= 6 &&
      gx + 6 < i32(global_width()) && gy + 6 < i32(global_height());
    if has_tile_result {
      rgb = choose_markesteijn(
        u32(gx) - input_x(),
        u32(gy) - input_y(),
      );
    } else {
      rgb = tile_initial_rgb(gx, gy);
    }
  }
  if id.x + 8u >= output_width() {
    overlap_right[id.y * 8u + id.x + 8u - output_width()] = rgb;
  }
  if id.y + 8u >= output_height() {
    let global_x = output_x() + id.x;
    let index = (id.y + 8u - output_height()) * global_width() + global_x;
    if band_index() % 2u == 0u {
      overlap_band_b[index] = rgb;
    } else {
      overlap_band_a[index] = rgb;
    }
  }
}

fn highlight_clip() -> u32 {
  return u32(min(65535.0 * parameter(24), min(65535.0 * parameter(25), 65535.0 * parameter(26))));
}

@compute @workgroup_size(16, 16)
fn blend_highlights(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= output_width() || id.y >= output_height() { return; }
  let index = id.y * output_width() + id.x;
  let source = chosen_rgb[index].xyz;
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
  chosen_rgb[index] = vec4u(vec3u(restored), 0u);
}

fn prophoto(rgb: vec3u) -> vec3u {
  let source = vec3f(rgb);
  var result = vec3u(0u);
  for (var component = 0u; component < 3u; component += 1u) {
    let base = 40u + component * 4u;
    let first = rounded_product(parameter(base), source.x);
    let second = rounded_product(parameter(base + 1u), source.y);
    let third = rounded_product(parameter(base + 2u), source.z);
    result[component] = u32(clamp(
      i32(rounded_sum(rounded_sum(first, second), third)),
      0,
      65535,
    ));
  }
  return result;
}

fn pack_pair(first: vec3u, second: vec3u, index: u32) {
  output[index * 3u] = first.x | (first.y << 16u);
  output[index * 3u + 1u] = first.z | (second.x << 16u);
  output[index * 3u + 2u] = second.y | (second.z << 16u);
}

@compute @workgroup_size(256)
fn write_final(@builtin(global_invocation_id) id: vec3u) {
  let pair = id.y * LINEAR_DISPATCH_WIDTH * 256u + id.x;
  let pixel_count = output_width() * output_height();
  let first_index = pair * 2u;
  if first_index >= pixel_count { return; }
  let first_rgb = chosen_rgb[first_index].xyz;
  let first = select(prophoto(first_rgb), first_rgb, write_demosaic_only());
  var second = vec3u(0u);
  if first_index + 1u < pixel_count {
    let second_rgb = chosen_rgb[first_index + 1u].xyz;
    second = select(prophoto(second_rgb), second_rgb, write_demosaic_only());
  }
  pack_pair(first, second, pair);
}
