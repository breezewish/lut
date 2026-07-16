@group(0) @binding(0) var<storage, read> tile: array<f32>;
@group(0) @binding(1) var<storage, read_write> frame: array<f32>;
@group(0) @binding(2) var<storage, read> parameters: array<u32>;

fn parameter(index: u32) -> f32 {
  return bitcast<f32>(parameters[index]);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let copy_width = parameters[7];
  let copy_height = parameters[8];
  if id.x >= copy_width || id.y >= copy_height {
    return;
  }

  let tile_size = parameters[0];
  let source_x = parameters[3] + id.x;
  let source_y = parameters[4] + id.y;
  let source_offset = (source_y * tile_size + source_x) * 3u;
  var rgb = vec3f(
    tile[source_offset],
    tile[source_offset + 1u],
    tile[source_offset + 2u],
  );
  if parameters[9] != 0u {
    rgb *= vec3f(parameter(10), parameter(11), parameter(12));
    rgb = vec3f(
      dot(vec3f(parameter(16), parameter(17), parameter(18)), rgb),
      dot(vec3f(parameter(20), parameter(21), parameter(22)), rgb),
      dot(vec3f(parameter(24), parameter(25), parameter(26)), rgb),
    );
    rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  }

  let destination_x = parameters[5] + id.x;
  let destination_y = parameters[6] + id.y;
  let destination_offset =
    (destination_y * parameters[1] + destination_x) * 3u;
  frame[destination_offset] = rgb.x;
  frame[destination_offset + 1u] = rgb.y;
  frame[destination_offset + 2u] = rgb.z;
}
