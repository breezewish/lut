struct Parameters {
  width: u32,
  height: u32,
  pixel_count: u32,
  _padding: u32,
}

const GRID_SIZE = 7u;
const ZONE_COUNT = 49u;
const HISTOGRAM_OFFSET = ZONE_COUNT * 2u;
const HISTOGRAM_BINS = 1024u;

@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> statistics: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

fn source_code(index: u32) -> u32 {
  let word = source[index / 2u];
  return select(word >> 16u, word & 0xffffu, index % 2u == 0u);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if id.x >= parameters.pixel_count {
    return;
  }

  let offset = id.x * 3u;
  let red = source_code(offset);
  let green = source_code(offset + 1u);
  let blue = source_code(offset + 2u);
  // The coefficients are the Y row of the corrected LibRaw ProPhoto D65 to
  // XYZ transform, derived through the checked-in sRGB conversion matrix.
  let luminance = clamp(
    0.2682055 * f32(red) + 0.7152171 * f32(green) + 0.0165769 * f32(blue),
    0.0,
    65535.0,
  );

  let x = id.x % parameters.width;
  let y = id.x / parameters.width;
  let zone_x = min(x * GRID_SIZE / parameters.width, GRID_SIZE - 1u);
  let zone_y = min(y * GRID_SIZE / parameters.height, GRID_SIZE - 1u);
  let zone = zone_y * GRID_SIZE + zone_x;
  atomicAdd(&statistics[zone], u32(luminance + 0.5));
  atomicAdd(&statistics[ZONE_COUNT + zone], 1u);

  let peak = max(red, max(green, blue));
  let bucket = min(peak * HISTOGRAM_BINS / 65536u, HISTOGRAM_BINS - 1u);
  atomicAdd(&statistics[HISTOGRAM_OFFSET + bucket], 1u);
}
