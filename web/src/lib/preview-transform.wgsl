struct Parameters {
  exposure: f32,
  lut_size: u32,
  source_width: u32,
  source_height: u32,
  output_width: u32,
  output_height: u32,
  pixel_count: u32,
  include_base: u32,
  domain_min: vec4f,
  inverse_domain_range: vec4f,
}

@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read> lut: array<f32>;
@group(0) @binding(2) var<storage, read_write> base_output: array<u32>;
@group(0) @binding(3) var<storage, read_write> lut_output: array<u32>;
@group(0) @binding(4) var<uniform> parameters: Parameters;

fn source_sample(index: u32) -> f32 {
  let word = source[index / 2u];
  let code = select(word >> 16u, word & 0xffffu, index % 2u == 0u);
  return f32(code) / 65535.0 * parameters.exposure;
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

fn pack_rgba8(rgb: vec3f) -> u32 {
  let code = vec3u(floor(clamp(rgb, vec3f(0.0), vec3f(1.0)) * 255.0 + 0.5));
  return code.x | (code.y << 8u) | (code.z << 16u) | 0xff000000u;
}

fn srgb_oetf(linear: f32) -> f32 {
  if linear <= 0.0031308 {
    return linear * 12.92;
  }
  return 1.055 * pow(linear, 1.0 / 2.4) - 0.055;
}

fn render_base(rgb: vec3f) -> vec3f {
  let linear = vec3f(
    2.0341926 * rgb.x + (-0.7274198 * rgb.y + -0.30676553 * rgb.z),
    -0.22881076 * rgb.x + (1.2317293 * rgb.y + -0.002921616 * rgb.z),
    -0.008564928 * rgb.x + (-0.15327258 * rgb.y + 1.161839 * rgb.z),
  );
  let luminance = 0.2126 * linear.x + (0.7152 * linear.y + 0.0722 * linear.z);
  let scale = select(1.0, 1.18 / (0.18 + luminance), luminance > 0.0);
  let display = max(linear * scale, vec3f(0.0));
  return vec3f(srgb_oetf(display.x), srgb_oetf(display.y), srgb_oetf(display.z));
}

fn render_lut(rgb: vec3f) -> vec3f {
  let linear = vec3f(
    1.1159087 * rgb.x + (-0.042472865 * rgb.y + -0.073432505 * rgb.z),
    -0.02851772 * rgb.x + (0.93679124 * rgb.y + 0.09172473 * rgb.z),
    0.01285477 * rgb.x + (-0.008144919 * rgb.y + 0.9952912 * rgb.z),
  );
  return tetrahedral_sample(vec3f(
    encode_v_log(linear.x),
    encode_v_log(linear.y),
    encode_v_log(linear.z),
  ));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= parameters.pixel_count {
    return;
  }

  let output_x = id.x % parameters.output_width;
  let output_y = id.x / parameters.output_width;
  let source_x = output_x * parameters.source_width / parameters.output_width;
  let source_y = output_y * parameters.source_height / parameters.output_height;
  let source_offset = (source_y * parameters.source_width + source_x) * 3u;
  let rgb = vec3f(
    source_sample(source_offset),
    source_sample(source_offset + 1u),
    source_sample(source_offset + 2u),
  );

  if parameters.include_base != 0u {
    base_output[id.x] = pack_rgba8(render_base(rgb));
  }
  lut_output[id.x] = pack_rgba8(render_lut(rgb));
}
