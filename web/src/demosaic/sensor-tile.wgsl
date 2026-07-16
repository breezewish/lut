@group(0) @binding(0) var<storage, read> mosaic: array<u32>;
@group(0) @binding(1) var<storage, read_write> tile: array<f32>;
@group(0) @binding(2) var<storage, read> parameters: array<u32>;

fn reflect_coordinate(value: u32, size: u32) -> u32 {
  if value < size {
    return value;
  }
  let period = 2u * (size - 1u);
  let position = value % period;
  return select(period - position, position, position < size);
}

fn sensor_sample(index: u32) -> f32 {
  let word = mosaic[index / 2u];
  let bits = select(word >> 16u, word & 0xffffu, index % 2u == 0u);
  return f32(bits);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let tile_size = parameters[2];
  if id.x >= tile_size || id.y >= tile_size {
    return;
  }

  let work_x = reflect_coordinate(parameters[3] + id.x, parameters[13]);
  let work_y = reflect_coordinate(parameters[4] + id.y, parameters[14]);
  let source_x = parameters[11] + work_x;
  let source_y = parameters[12] + work_y;
  let cfa_size = parameters[5];
  let cfa_index = (source_y % cfa_size) * cfa_size + source_x % cfa_size;
  let channel = min(parameters[16u + cfa_index], 3u);
  let black = bitcast<f32>(parameters[7u + channel]);
  let white = bitcast<f32>(parameters[6]);
  let value = max(sensor_sample(source_y * parameters[0] + source_x) - black, 0.0);
  tile[id.y * tile_size + id.x] = value / (white - black);
}
