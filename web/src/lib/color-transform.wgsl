struct Parameters {
  exposure: f32,
  lut_size: u32,
  pixel_count: u32,
  _padding: u32,
  domain_min: vec4f,
  inverse_domain_range: vec4f,
  white_balance_0: vec4f,
  white_balance_1: vec4f,
  white_balance_2: vec4f,
}

@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read> lut: array<f32>;
@group(0) @binding(2) var<storage, read_write> destination: array<u32>;
@group(0) @binding(3) var<uniform> parameters: Parameters;

fn unpack_low(word: u32) -> f32 {
  return f32(word & 0xffffu) / 65535.0 * parameters.exposure;
}

fn unpack_high(word: u32) -> f32 {
  return f32(word >> 16u) / 65535.0 * parameters.exposure;
}

fn encode_v_log(value: f32) -> f32 {
  if value < 0.01 {
    return 5.6 * value + 0.125;
  }
  return 0.241514 * (log2(value + 0.00873) * 0.3010299956639812) + 0.598206;
}

fn lut_sample(red: u32, green: u32, blue: u32) -> vec3f {
  let offset = ((blue * parameters.lut_size + green) * parameters.lut_size + red) * 3u;
  return vec3f(lut[offset], lut[offset + 1u], lut[offset + 2u]);
}

fn tetrahedral_sample(rgb: vec3f) -> vec3f {
  let scale = f32(parameters.lut_size - 1u);
  let position = clamp(
    (rgb - parameters.domain_min.xyz) * parameters.inverse_domain_range.xyz,
    vec3f(0.0),
    vec3f(1.0),
  ) * scale;
  let low = min(vec3u(floor(position)), vec3u(parameters.lut_size - 2u));
  let fraction = position - vec3f(low);

  let c000 = lut_sample(low.x, low.y, low.z);
  let c100 = lut_sample(low.x + 1u, low.y, low.z);
  let c010 = lut_sample(low.x, low.y + 1u, low.z);
  let c001 = lut_sample(low.x, low.y, low.z + 1u);
  let c110 = lut_sample(low.x + 1u, low.y + 1u, low.z);
  let c101 = lut_sample(low.x + 1u, low.y, low.z + 1u);
  let c011 = lut_sample(low.x, low.y + 1u, low.z + 1u);
  let c111 = lut_sample(low.x + 1u, low.y + 1u, low.z + 1u);
  let r = fraction.x;
  let g = fraction.y;
  let b = fraction.z;

  if r >= g {
    if g >= b {
      return c000 + r * (c100 - c000) + g * (c110 - c100) + b * (c111 - c110);
    }
    if r >= b {
      return c000 + r * (c100 - c000) + b * (c101 - c100) + g * (c111 - c101);
    }
    return c000 + b * (c001 - c000) + r * (c101 - c001) + g * (c111 - c101);
  }
  if r >= b {
    return c000 + g * (c010 - c000) + r * (c110 - c010) + b * (c111 - c110);
  }
  if g >= b {
    return c000 + g * (c010 - c000) + b * (c011 - c010) + r * (c111 - c011);
  }
  return c000 + b * (c001 - c000) + g * (c011 - c001) + r * (c111 - c011);
}

fn render_pixel(rgb: vec3f) -> vec3u {
  let balanced = vec3f(
    dot(parameters.white_balance_0.xyz, rgb),
    dot(parameters.white_balance_1.xyz, rgb),
    dot(parameters.white_balance_2.xyz, rgb),
  );
  let linear = vec3f(
    1.1159087 * balanced.x + (-0.042472865 * balanced.y + -0.073432505 * balanced.z),
    -0.02851772 * balanced.x + (0.93679124 * balanced.y + 0.09172473 * balanced.z),
    0.01285477 * balanced.x + (-0.008144919 * balanced.y + 0.9952912 * balanced.z),
  );
  let encoded = vec3f(
    encode_v_log(linear.x),
    encode_v_log(linear.y),
    encode_v_log(linear.z),
  );
  return vec3u(floor(clamp(tetrahedral_sample(encoded), vec3f(0.0), vec3f(1.0)) * 65535.0 + 0.5));
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let first_pixel = id.x * 2u;
  if first_pixel >= parameters.pixel_count {
    return;
  }

  let word_offset = id.x * 3u;
  let word0 = source[word_offset];
  let word1 = source[word_offset + 1u];
  let word2 = source[word_offset + 2u];
  let first = render_pixel(vec3f(unpack_low(word0), unpack_high(word0), unpack_low(word1)));
  var second = vec3u(0u);
  if first_pixel + 1u < parameters.pixel_count {
    second = render_pixel(vec3f(unpack_high(word1), unpack_low(word2), unpack_high(word2)));
  }

  destination[word_offset] = first.x | (first.y << 16u);
  destination[word_offset + 1u] = first.z | (second.x << 16u);
  destination[word_offset + 2u] = second.y | (second.z << 16u);
}
