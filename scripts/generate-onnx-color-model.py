#!/usr/bin/env python3
"""Generate the portable ONNX color graph used by the browser experiment.

Run with:
    uv run --with onnx==1.19.1 scripts/generate-onnx-color-model.py
"""

from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "web/src/lib/color-transform.onnx"
nodes: list[onnx.NodeProto] = []
initializers: list[onnx.TensorProto] = []


def constant(name: str, value: np.ndarray) -> str:
    initializers.append(numpy_helper.from_array(value, name))
    return name


def node(op_type: str, inputs: list[str], output: str, **attributes: object) -> str:
    nodes.append(helper.make_node(op_type, inputs, [output], **attributes))
    return output


def binary(op_type: str, left: str, right: str, output: str) -> str:
    return node(op_type, [left, right], output)


def select_branch(
    name: str,
    values: tuple[str, str, str, str, str, str],
) -> str:
    """Select one of the shader's six tie-sensitive tetrahedral regions."""
    case1, case2, case3, case4, case5, case6 = values
    right_tail = node("Where", ["r_ge_b", case2, case3], f"{name}_right_tail")
    right = node("Where", ["g_ge_b", case1, right_tail], f"{name}_right")
    left_tail = node("Where", ["g_ge_b", case5, case6], f"{name}_left_tail")
    left = node("Where", ["r_ge_b", case4, left_tail], f"{name}_left")
    return node("Where", ["r_ge_g", right, left], name)


f32_zero = constant("f32_zero", np.array(0.0, dtype=np.float32))
f32_one = constant("f32_one", np.array(1.0, dtype=np.float32))
i32_one = constant("i32_one", np.array(1, dtype=np.int32))
i64_axis_one = constant("i64_axis_one", np.array([1], dtype=np.int64))
i64_r = constant("i64_r", np.array(0, dtype=np.int64))
i64_g = constant("i64_g", np.array(1, dtype=np.int64))
i64_b = constant("i64_b", np.array(2, dtype=np.int64))

matrix = constant(
    "prophoto_to_v_gamut_transposed",
    np.array(
        [
            [1.1159087, -0.02851772, 0.01285477],
            [-0.042472865, 0.93679124, -0.008144919],
            [-0.073432505, 0.09172473, 0.9952912],
        ],
        dtype=np.float32,
    ),
)

normalized = binary(
    "Div",
    "source",
    constant("rgb16_scale", np.array(65535.0, dtype=np.float32)),
    "normalized",
)
exposed = binary("Mul", normalized, "exposure", "exposed")
linear = node("MatMul", [exposed, matrix], "linear")

low_curve = binary(
    "Add",
    binary(
        "Mul",
        linear,
        constant("vlog_slope", np.array(5.6, dtype=np.float32)),
        "low_scaled",
    ),
    constant("vlog_intercept", np.array(0.125, dtype=np.float32)),
    "low_curve",
)
use_low_curve = binary(
    "Less",
    linear,
    constant("vlog_cut", np.array(0.01, dtype=np.float32)),
    "use_low_curve",
)
log_input = binary(
    "Add",
    linear,
    constant("vlog_log_offset", np.array(0.00873, dtype=np.float32)),
    "log_input_unchecked",
)
safe_log_input = node("Where", [use_low_curve, f32_one, log_input], "safe_log_input")
log_curve = binary(
    "Add",
    binary(
        "Mul",
        node("Log", [safe_log_input], "natural_log"),
        constant(
            "vlog_log_scale",
            np.array(0.241514 / np.log(10.0), dtype=np.float32),
        ),
        "scaled_log",
    ),
    constant("vlog_log_intercept", np.array(0.598206, dtype=np.float32)),
    "log_curve",
)
encoded = node("Where", [use_low_curve, low_curve, log_curve], "encoded")

domain_position = binary(
    "Mul",
    binary("Sub", encoded, "domain_min", "domain_offset"),
    "inverse_domain_range",
    "domain_position",
)
clamped_domain_position = node(
    "Clip", [domain_position, f32_zero, f32_one], "clamped_domain_position"
)
lut_size_f32 = node("Cast", ["lut_size"], "lut_size_f32", to=TensorProto.FLOAT)
lut_scale = binary("Sub", lut_size_f32, f32_one, "lut_scale")
position = binary("Mul", clamped_domain_position, lut_scale, "position")
low_max = binary("Sub", lut_scale, f32_one, "low_max")
low_f32 = node(
    "Clip",
    [node("Floor", [position], "floored_position"), f32_zero, low_max],
    "low_f32",
)
fraction = binary("Sub", position, low_f32, "fraction")
low = node("Cast", [low_f32], "low", to=TensorProto.INT32)

r = node("Gather", [low, i64_r], "r", axis=1)
g = node("Gather", [low, i64_g], "g", axis=1)
b = node("Gather", [low, i64_b], "b", axis=1)
rf = node("Gather", [fraction, i64_r], "rf", axis=1)
gf = node("Gather", [fraction, i64_g], "gf", axis=1)
bf = node("Gather", [fraction, i64_b], "bf", axis=1)

node("GreaterOrEqual", [rf, gf], "r_ge_g")
node("GreaterOrEqual", [gf, bf], "g_ge_b")
node("GreaterOrEqual", [rf, bf], "r_ge_b")

lut_plane = binary("Mul", "lut_size", "lut_size", "lut_plane")
base = binary(
    "Add",
    binary(
        "Mul",
        binary("Add", binary("Mul", b, "lut_size", "b_rows"), g, "bg_row"),
        "lut_size",
        "bg_plane",
    ),
    r,
    "base",
)
i100 = binary("Add", base, i32_one, "i100")
i010 = binary("Add", base, "lut_size", "i010")
i001 = binary("Add", base, lut_plane, "i001")
i110 = binary("Add", i010, i32_one, "i110")
i101 = binary("Add", i001, i32_one, "i101")
i011 = binary("Add", i001, "lut_size", "i011")
i111 = binary("Add", i011, i32_one, "i111")

i1 = select_branch("i1", (i100, i100, i001, i010, i010, i001))
i2 = select_branch("i2", (i110, i101, i101, i110, i011, i011))
w1 = select_branch("w1", (rf, rf, bf, gf, gf, bf))
w2 = select_branch("w2", (gf, bf, rf, rf, bf, gf))
w3 = select_branch("w3", (bf, gf, gf, bf, rf, rf))

c000 = node("Gather", ["lut", base], "c000", axis=0)
c1 = node("Gather", ["lut", i1], "c1", axis=0)
c2 = node("Gather", ["lut", i2], "c2", axis=0)
c111 = node("Gather", ["lut", i111], "c111", axis=0)
w1_column = node("Unsqueeze", [w1, i64_axis_one], "w1_column")
w2_column = node("Unsqueeze", [w2, i64_axis_one], "w2_column")
w3_column = node("Unsqueeze", [w3, i64_axis_one], "w3_column")
interpolated = binary(
    "Add",
    binary(
        "Add",
        binary(
            "Add",
            c000,
            binary(
                "Mul", w1_column, binary("Sub", c1, c000, "c1_delta"), "c1_weighted"
            ),
            "through_c1",
        ),
        binary("Mul", w2_column, binary("Sub", c2, c1, "c2_delta"), "c2_weighted"),
        "through_c2",
    ),
    binary("Mul", w3_column, binary("Sub", c111, c2, "c111_delta"), "c111_weighted"),
    "interpolated",
)

clamped = node("Clip", [interpolated, f32_zero, f32_one], "clamped")
node(
    "Floor",
    [
        binary(
            "Add",
            binary(
                "Mul",
                clamped,
                constant("output_scale", np.array(65535.0, dtype=np.float32)),
                "output_scaled",
            ),
            constant("rounding_offset", np.array(0.5, dtype=np.float32)),
            "output_rounded",
        )
    ],
    "rgb16",
)

graph = helper.make_graph(
    nodes,
    "raw-alchemy-color",
    [
        helper.make_tensor_value_info("source", TensorProto.FLOAT, ["pixels", 3]),
        helper.make_tensor_value_info("lut", TensorProto.FLOAT, ["lut_entries", 3]),
        helper.make_tensor_value_info("exposure", TensorProto.FLOAT, []),
        helper.make_tensor_value_info("lut_size", TensorProto.INT32, []),
        helper.make_tensor_value_info("domain_min", TensorProto.FLOAT, [3]),
        helper.make_tensor_value_info("inverse_domain_range", TensorProto.FLOAT, [3]),
    ],
    [helper.make_tensor_value_info("rgb16", TensorProto.FLOAT, ["pixels", 3])],
    initializers,
)
model = helper.make_model(
    graph,
    producer_name="raw-alchemy",
    opset_imports=[helper.make_opsetid("", 18)],
)
model.ir_version = 10
onnx.checker.check_model(model)
OUTPUT.write_bytes(model.SerializeToString())
print(
    f"Wrote {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes, {len(nodes)} nodes)"
)
