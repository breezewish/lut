@group(0) @binding(0) var<storage, read> mosaic: array<u32>;
@group(0) @binding(1) var<storage, read_write> cfa: array<f32>;
@group(0) @binding(2) var<storage, read_write> red: array<f32>;
@group(0) @binding(3) var<storage, read_write> green: array<f32>;
@group(0) @binding(4) var<storage, read_write> blue: array<f32>;
@group(0) @binding(5) var<storage, read_write> scratch0: array<f32>;
@group(0) @binding(6) var<storage, read_write> scratch1: array<f32>;
@group(0) @binding(7) var<storage, read_write> scratch2: array<f32>;
@group(0) @binding(8) var<storage, read_write> scratch3: array<f32>;
@group(0) @binding(9) var<storage, read_write> output: array<u32>;
@group(0) @binding(10) var<storage, read> lut: array<f32>;
@group(0) @binding(11) var<storage, read> parameters: array<u32>;

const EPS: f32 = 1e-5;
const EPSSQ: f32 = 1e-10;

fn width() -> u32 { return parameters[0]; }
fn height() -> u32 { return parameters[1]; }
fn offset(x: u32, y: u32) -> u32 { return y * width() + x; }
fn value(index: u32) -> f32 { return bitcast<f32>(parameters[index]); }

fn cfa_color(x: u32, y: u32) -> u32 {
  let color = parameters[48u + (y & 1u) * 2u + (x & 1u)];
  return select(color, 1u, color == 3u);
}

fn sensor_sample(index: u32) -> f32 {
  let word = mosaic[index / 2u];
  let bits = select(word >> 16u, word & 0xffffu, index % 2u == 0u);
  return f32(bits);
}

fn in_bounds(id: vec3u) -> bool {
  return id.x < width() && id.y < height();
}

@compute @workgroup_size(16, 16)
fn preprocess(@builtin(global_invocation_id) id: vec3u) {
  if !in_bounds(id) { return; }
  let i = offset(id.x, id.y);
  let color = cfa_color(id.x, id.y);
  let black = value(12u + color);
  let normalized = max(sensor_sample(i) - black, 0.0) / (value(16) - black);
  cfa[i] = normalized;
  red[i] = select(0.0, normalized, color == 0u);
  green[i] = select(0.0, normalized, color == 1u);
  blue[i] = select(0.0, normalized, color == 2u);
}

fn cfa_at(x: i32, y: i32) -> f32 {
  return cfa[offset(u32(x), u32(y))];
}

@compute @workgroup_size(16, 16)
fn vertical_horizontal(@builtin(global_invocation_id) id: vec3u) {
  if !in_bounds(id) || id.x < 4u || id.y < 4u || id.x + 4u >= width() || id.y + 4u >= height() { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  var vertical = EPSSQ;
  for (var delta = -1; delta <= 1; delta += 1) {
    let row = y + delta;
    let high = cfa_at(x, row - 3) - cfa_at(x, row - 1) - cfa_at(x, row + 1) + cfa_at(x, row + 3)
      - 3.0 * (cfa_at(x, row - 2) + cfa_at(x, row + 2)) + 6.0 * cfa_at(x, row);
    vertical += high * high;
  }
  var horizontal = EPSSQ;
  for (var delta = -1; delta <= 1; delta += 1) {
    let column = x + delta;
    let high = cfa_at(column - 3, y) - cfa_at(column - 1, y) - cfa_at(column + 1, y) + cfa_at(column + 3, y)
      - 3.0 * (cfa_at(column - 2, y) + cfa_at(column + 2, y)) + 6.0 * cfa_at(column, y);
    horizontal += high * high;
  }
  vertical = max(EPSSQ, vertical);
  horizontal = max(EPSSQ, horizontal);
  scratch0[offset(id.x, id.y)] = vertical / (vertical + horizontal);
}

@compute @workgroup_size(16, 16)
fn low_pass(@builtin(global_invocation_id) id: vec3u) {
  if !in_bounds(id) || id.x < 2u || id.y < 2u || id.x + 2u >= width() || id.y + 2u >= height() || cfa_color(id.x, id.y) == 1u { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  scratch1[offset(id.x, id.y)] = cfa_at(x, y)
    + 0.5 * (cfa_at(x, y - 1) + cfa_at(x, y + 1) + cfa_at(x - 1, y) + cfa_at(x + 1, y))
    + 0.25 * (cfa_at(x - 1, y - 1) + cfa_at(x + 1, y - 1) + cfa_at(x - 1, y + 1) + cfa_at(x + 1, y + 1));
}

fn plane_at(plane: u32, x: i32, y: i32) -> f32 {
  let i = offset(u32(x), u32(y));
  if plane == 0u { return red[i]; }
  if plane == 1u { return green[i]; }
  return blue[i];
}

fn vh_direction(x: i32, y: i32) -> f32 {
  let center = scratch0[offset(u32(x), u32(y))];
  let neighbor = 0.25 * (
    scratch0[offset(u32(x - 1), u32(y - 1))] +
    scratch0[offset(u32(x + 1), u32(y - 1))] +
    scratch0[offset(u32(x - 1), u32(y + 1))] +
    scratch0[offset(u32(x + 1), u32(y + 1))]
  );
  return select(center, neighbor, abs(0.5 - center) < abs(0.5 - neighbor));
}

@compute @workgroup_size(16, 16)
fn interpolate_green(@builtin(global_invocation_id) id: vec3u) {
  if !in_bounds(id) || id.x < 4u || id.y < 4u || id.x + 4u >= width() || id.y + 4u >= height() || cfa_color(id.x, id.y) == 1u { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let center = cfa_at(x, y);
  let north_gradient = EPS + abs(cfa_at(x, y - 1) - cfa_at(x, y + 1)) + abs(center - cfa_at(x, y - 2))
    + abs(cfa_at(x, y - 1) - cfa_at(x, y - 3)) + abs(cfa_at(x, y - 2) - cfa_at(x, y - 4));
  let south_gradient = EPS + abs(cfa_at(x, y + 1) - cfa_at(x, y - 1)) + abs(center - cfa_at(x, y + 2))
    + abs(cfa_at(x, y + 1) - cfa_at(x, y + 3)) + abs(cfa_at(x, y + 2) - cfa_at(x, y + 4));
  let west_gradient = EPS + abs(cfa_at(x - 1, y) - cfa_at(x + 1, y)) + abs(center - cfa_at(x - 2, y))
    + abs(cfa_at(x - 1, y) - cfa_at(x - 3, y)) + abs(cfa_at(x - 2, y) - cfa_at(x - 4, y));
  let east_gradient = EPS + abs(cfa_at(x + 1, y) - cfa_at(x - 1, y)) + abs(center - cfa_at(x + 2, y))
    + abs(cfa_at(x + 1, y) - cfa_at(x + 3, y)) + abs(cfa_at(x + 2, y) - cfa_at(x + 4, y));
  let low = scratch1[offset(id.x, id.y)];
  let north = cfa_at(x, y - 1) * (2.0 * low) / (EPS + low + scratch1[offset(id.x, id.y - 2u)]);
  let south = cfa_at(x, y + 1) * (2.0 * low) / (EPS + low + scratch1[offset(id.x, id.y + 2u)]);
  let west = cfa_at(x - 1, y) * (2.0 * low) / (EPS + low + scratch1[offset(id.x - 2u, id.y)]);
  let east = cfa_at(x + 1, y) * (2.0 * low) / (EPS + low + scratch1[offset(id.x + 2u, id.y)]);
  let vertical = (south_gradient * north + north_gradient * south) / (north_gradient + south_gradient);
  let horizontal = (west_gradient * east + east_gradient * west) / (east_gradient + west_gradient);
  let direction = clamp(vh_direction(x, y), 0.0, 1.0);
  green[offset(id.x, id.y)] = direction * (horizontal - vertical) + vertical;
}

@compute @workgroup_size(16, 16)
fn diagonal_high_pass(@builtin(global_invocation_id) id: vec3u) {
  if !in_bounds(id) || id.x < 3u || id.y < 3u || id.x + 3u >= width() || id.y + 3u >= height() { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let p = cfa_at(x - 3, y - 3) - cfa_at(x - 1, y - 1) - cfa_at(x + 1, y + 1) + cfa_at(x + 3, y + 3)
    - 3.0 * (cfa_at(x - 2, y - 2) + cfa_at(x + 2, y + 2)) + 6.0 * cfa_at(x, y);
  let q = cfa_at(x + 3, y - 3) - cfa_at(x + 1, y - 1) - cfa_at(x - 1, y + 1) + cfa_at(x - 3, y + 3)
    - 3.0 * (cfa_at(x + 2, y - 2) + cfa_at(x - 2, y + 2)) + 6.0 * cfa_at(x, y);
  scratch1[offset(id.x, id.y)] = p * p;
  scratch2[offset(id.x, id.y)] = q * q;
}

@compute @workgroup_size(16, 16)
fn diagonal_direction(@builtin(global_invocation_id) id: vec3u) {
  if !in_bounds(id) || id.x < 4u || id.y < 4u || id.x + 4u >= width() || id.y + 4u >= height() || cfa_color(id.x, id.y) == 1u { return; }
  let i = offset(id.x, id.y);
  let p = max(EPSSQ, scratch1[offset(id.x - 1u, id.y - 1u)] + scratch1[i] + scratch1[offset(id.x + 1u, id.y + 1u)]);
  let q = max(EPSSQ, scratch2[offset(id.x + 1u, id.y - 1u)] + scratch2[i] + scratch2[offset(id.x - 1u, id.y + 1u)]);
  scratch3[i] = p / (p + q);
}

fn opposite_color(plane: u32, x: i32, y: i32) -> f32 {
  let center_direction = scratch3[offset(u32(x), u32(y))];
  let neighbor_direction = 0.25 * (
    scratch3[offset(u32(x - 1), u32(y - 1))] + scratch3[offset(u32(x + 1), u32(y - 1))] +
    scratch3[offset(u32(x - 1), u32(y + 1))] + scratch3[offset(u32(x + 1), u32(y + 1))]
  );
  let direction = clamp(select(center_direction, neighbor_direction, abs(0.5 - center_direction) < abs(0.5 - neighbor_direction)), 0.0, 1.0);
  let g = plane_at(1u, x, y);
  let nw = plane_at(plane, x - 1, y - 1);
  let ne = plane_at(plane, x + 1, y - 1);
  let sw = plane_at(plane, x - 1, y + 1);
  let se = plane_at(plane, x + 1, y + 1);
  let nw_gradient = EPS + abs(nw - se) + abs(nw - plane_at(plane, x - 3, y - 3)) + abs(g - plane_at(1u, x - 2, y - 2));
  let ne_gradient = EPS + abs(ne - sw) + abs(ne - plane_at(plane, x + 3, y - 3)) + abs(g - plane_at(1u, x + 2, y - 2));
  let sw_gradient = EPS + abs(ne - sw) + abs(sw - plane_at(plane, x - 3, y + 3)) + abs(g - plane_at(1u, x - 2, y + 2));
  let se_gradient = EPS + abs(nw - se) + abs(se - plane_at(plane, x + 3, y + 3)) + abs(g - plane_at(1u, x + 2, y + 2));
  let nw_estimate = nw - plane_at(1u, x - 1, y - 1);
  let ne_estimate = ne - plane_at(1u, x + 1, y - 1);
  let sw_estimate = sw - plane_at(1u, x - 1, y + 1);
  let se_estimate = se - plane_at(1u, x + 1, y + 1);
  let p = (nw_gradient * se_estimate + se_gradient * nw_estimate) / (nw_gradient + se_gradient);
  let q = (ne_gradient * sw_estimate + sw_gradient * ne_estimate) / (ne_gradient + sw_gradient);
  return g + direction * (q - p) + p;
}

@compute @workgroup_size(16, 16)
fn interpolate_opposite(@builtin(global_invocation_id) id: vec3u) {
  if !in_bounds(id) || id.x < 4u || id.y < 4u || id.x + 4u >= width() || id.y + 4u >= height() { return; }
  let color = cfa_color(id.x, id.y);
  if color == 1u { return; }
  let opposite = 2u - color;
  let result = opposite_color(opposite, i32(id.x), i32(id.y));
  if opposite == 0u { red[offset(id.x, id.y)] = result; }
  if opposite == 2u { blue[offset(id.x, id.y)] = result; }
}

fn green_site_color(plane: u32, x: i32, y: i32, direction: f32) -> f32 {
  let g = plane_at(1u, x, y);
  let north = plane_at(plane, x, y - 1);
  let south = plane_at(plane, x, y + 1);
  let west = plane_at(plane, x - 1, y);
  let east = plane_at(plane, x + 1, y);
  let north_green = plane_at(1u, x, y - 1);
  let south_green = plane_at(1u, x, y + 1);
  let west_green = plane_at(1u, x - 1, y);
  let east_green = plane_at(1u, x + 1, y);
  let vertical_difference = abs(north - south);
  let horizontal_difference = abs(west - east);
  let north_gradient = EPS + abs(g - plane_at(1u, x, y - 2)) + vertical_difference + abs(north - plane_at(plane, x, y - 3));
  let south_gradient = EPS + abs(g - plane_at(1u, x, y + 2)) + vertical_difference + abs(south - plane_at(plane, x, y + 3));
  let west_gradient = EPS + abs(g - plane_at(1u, x - 2, y)) + horizontal_difference + abs(west - plane_at(plane, x - 3, y));
  let east_gradient = EPS + abs(g - plane_at(1u, x + 2, y)) + horizontal_difference + abs(east - plane_at(plane, x + 3, y));
  let north_estimate = north - north_green;
  let south_estimate = south - south_green;
  let west_estimate = west - west_green;
  let east_estimate = east - east_green;
  let vertical = (north_gradient * south_estimate + south_gradient * north_estimate) / (north_gradient + south_gradient);
  let horizontal = (east_gradient * west_estimate + west_gradient * east_estimate) / (east_gradient + west_gradient);
  return g + direction * (horizontal - vertical) + vertical;
}

@compute @workgroup_size(16, 16)
fn interpolate_green_sites(@builtin(global_invocation_id) id: vec3u) {
  if !in_bounds(id) || id.x < 4u || id.y < 4u || id.x + 4u >= width() || id.y + 4u >= height() || cfa_color(id.x, id.y) != 1u { return; }
  let direction = clamp(vh_direction(i32(id.x), i32(id.y)), 0.0, 1.0);
  let i = offset(id.x, id.y);
  red[i] = green_site_color(0u, i32(id.x), i32(id.y), direction);
  blue[i] = green_site_color(2u, i32(id.x), i32(id.y), direction);
}

fn bilinear_pixel(x: u32, y: u32) -> vec3f {
  var sums = vec3f(0.0);
  var counts = vec3f(0.0);
  for (var dy = -1; dy <= 1; dy += 1) {
    for (var dx = -1; dx <= 1; dx += 1) {
      let sx = i32(x) + dx;
      let sy = i32(y) + dy;
      if sx >= 0 && sy >= 0 && sx < i32(width()) && sy < i32(height()) {
        let channel = cfa_color(u32(sx), u32(sy));
        let sample = cfa_at(sx, sy);
        if channel == 0u { sums.x += sample; counts.x += 1.0; }
        if channel == 1u { sums.y += sample; counts.y += 1.0; }
        if channel == 2u { sums.z += sample; counts.z += 1.0; }
      }
    }
  }
  return sums / max(counts, vec3f(1.0));
}

fn camera_pixel(pixel: u32) -> vec3f {
  let x = pixel % width();
  let y = pixel / width();
  if x < 4u || y < 4u || x + 4u >= width() || y + 4u >= height() {
    return bilinear_pixel(x, y);
  }
  let i = offset(x, y);
  return max(vec3f(red[i], green[i], blue[i]), vec3f(0.0));
}

fn prophoto_pixel(pixel: u32) -> vec3f {
  let balanced = camera_pixel(pixel) * vec3f(value(20), value(21), value(22));
  return clamp(vec3f(
    dot(vec3f(value(24), value(25), value(26)), balanced),
    dot(vec3f(value(27), value(28), value(29)), balanced),
    dot(vec3f(value(30), value(31), value(32)), balanced)
  ), vec3f(0.0), vec3f(1.0));
}

fn encode_v_log(sample: f32) -> f32 {
  if sample < 0.01 { return 5.6 * sample + 0.125; }
  return 0.241514 * (log2(sample + 0.00873) * 0.3010299956639812) + 0.598206;
}

fn lut_sample(r: u32, g: u32, b: u32) -> vec3f {
  let size = parameters[4];
  let i = ((b * size + g) * size + r) * 3u;
  return vec3f(lut[i], lut[i + 1u], lut[i + 2u]);
}

fn tetrahedral_sample(rgb: vec3f) -> vec3f {
  let size = parameters[4];
  let scale = f32(size - 1u);
  let position = clamp((rgb - vec3f(value(36), value(37), value(38))) * vec3f(value(40), value(41), value(42)), vec3f(0.0), vec3f(1.0)) * scale;
  let low = min(vec3u(floor(position)), vec3u(size - 2u));
  let f = position - vec3f(low);
  let c000 = lut_sample(low.x, low.y, low.z);
  let c100 = lut_sample(low.x + 1u, low.y, low.z);
  let c010 = lut_sample(low.x, low.y + 1u, low.z);
  let c001 = lut_sample(low.x, low.y, low.z + 1u);
  let c110 = lut_sample(low.x + 1u, low.y + 1u, low.z);
  let c101 = lut_sample(low.x + 1u, low.y, low.z + 1u);
  let c011 = lut_sample(low.x, low.y + 1u, low.z + 1u);
  let c111 = lut_sample(low.x + 1u, low.y + 1u, low.z + 1u);
  if f.x >= f.y {
    if f.y >= f.z { return c000 + f.x * (c100 - c000) + f.y * (c110 - c100) + f.z * (c111 - c110); }
    if f.x >= f.z { return c000 + f.x * (c100 - c000) + f.z * (c101 - c100) + f.y * (c111 - c101); }
    return c000 + f.z * (c001 - c000) + f.x * (c101 - c001) + f.y * (c111 - c101);
  }
  if f.x >= f.z { return c000 + f.y * (c010 - c000) + f.x * (c110 - c010) + f.z * (c111 - c110); }
  if f.y >= f.z { return c000 + f.y * (c010 - c000) + f.z * (c011 - c010) + f.x * (c111 - c011); }
  return c000 + f.z * (c001 - c000) + f.y * (c011 - c001) + f.x * (c111 - c011);
}

fn render_pixel(pixel: u32) -> vec3u {
  let prophoto = prophoto_pixel(pixel);
  if parameters[5] == 0u {
    return vec3u(floor(prophoto * 65535.0 + 0.5));
  }
  let exposed = prophoto * value(8);
  let working = vec3f(
    1.1159087 * exposed.x - 0.042472865 * exposed.y - 0.073432505 * exposed.z,
    -0.02851772 * exposed.x + 0.93679124 * exposed.y + 0.09172473 * exposed.z,
    0.01285477 * exposed.x - 0.008144919 * exposed.y + 0.9952912 * exposed.z
  );
  let encoded = vec3f(encode_v_log(working.x), encode_v_log(working.y), encode_v_log(working.z));
  return vec3u(floor(clamp(tetrahedral_sample(encoded), vec3f(0.0), vec3f(1.0)) * 65535.0 + 0.5));
}

@compute @workgroup_size(16, 16)
fn finish(@builtin(global_invocation_id) id: vec3u) {
  let pairs_per_row = width() / 2u;
  if id.x >= pairs_per_row || id.y >= height() { return; }
  let pair = id.y * pairs_per_row + id.x;
  let first_pixel = id.y * width() + id.x * 2u;
  let first = render_pixel(first_pixel);
  let second = render_pixel(first_pixel + 1u);
  let word = pair * 3u;
  output[word] = first.x | (first.y << 16u);
  output[word + 1u] = first.z | (second.x << 16u);
  output[word + 2u] = second.y | (second.z << 16u);
}
