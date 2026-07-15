use crate::{AlchemyError, Result};

/// A strict, immutable 3D CUBE lookup table.
///
/// Samples are stored in the file-defined order: red changes fastest, then
/// green, then blue. Lookup uses tetrahedral interpolation.
#[derive(Clone, Debug)]
pub struct Lut3d {
    size: usize,
    domain_min: [f32; 3],
    domain_max: [f32; 3],
    samples: Vec<[f32; 3]>,
}

impl Lut3d {
    /// Parses a 3D `.cube` file and rejects ambiguous or malformed content.
    ///
    /// # Errors
    ///
    /// Returns [`AlchemyError::InvalidCube`] or
    /// [`AlchemyError::InvalidCubeSampleCount`] when the file is not one
    /// complete, finite 3D LUT.
    pub fn parse(source: &str) -> Result<Self> {
        let mut size = None;
        let mut domain_min = [0.0; 3];
        let mut domain_max = [1.0; 3];
        let mut samples = Vec::new();

        for (index, raw_line) in source.lines().enumerate() {
            let line_number = index + 1;
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("TITLE ") {
                continue;
            }

            let fields: Vec<_> = line.split_whitespace().collect();
            match fields.first().copied() {
                Some("LUT_3D_SIZE") => {
                    if size.is_some() || fields.len() != 2 {
                        return invalid(line_number, "LUT_3D_SIZE must appear exactly once");
                    }
                    let parsed = fields[1]
                        .parse::<usize>()
                        .map_err(|_| cube_error(line_number, "invalid LUT size"))?;
                    if !(2..=129).contains(&parsed) {
                        return invalid(line_number, "LUT size must be within 2..=129");
                    }
                    size = Some(parsed);
                }
                Some("DOMAIN_MIN") => {
                    domain_min = parse_triplet(&fields, line_number, "DOMAIN_MIN")?;
                }
                Some("DOMAIN_MAX") => {
                    domain_max = parse_triplet(&fields, line_number, "DOMAIN_MAX")?;
                }
                Some(token) if token.starts_with("LUT_") => {
                    return invalid(line_number, "only a single 3D LUT is supported");
                }
                _ => samples.push(parse_triplet(&fields, line_number, "sample")?),
            }
        }

        let size = size.ok_or_else(|| cube_error(0, "missing LUT_3D_SIZE"))?;
        for axis in 0..3 {
            if domain_max[axis] <= domain_min[axis] {
                return invalid(0, "DOMAIN_MAX must be greater than DOMAIN_MIN");
            }
        }
        let expected = size.checked_pow(3).ok_or(AlchemyError::ImageTooLarge)?;
        if samples.len() != expected {
            return Err(AlchemyError::InvalidCubeSampleCount {
                actual: samples.len(),
                expected,
            });
        }

        Ok(Self {
            size,
            domain_min,
            domain_max,
            samples,
        })
    }

    /// Returns the number of nodes on one edge.
    #[must_use]
    pub fn size(&self) -> usize {
        self.size
    }

    /// Samples the LUT with tetrahedral interpolation and clamps only at the
    /// declared lookup domain boundary.
    #[must_use]
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss
    )]
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let scale = (self.size - 1) as f32;
        let position: [f32; 3] = core::array::from_fn(|axis| {
            let normalized = (rgb[axis] - self.domain_min[axis])
                / (self.domain_max[axis] - self.domain_min[axis]);
            normalized.clamp(0.0, 1.0) * scale
        });
        let low = position.map(|value| (value.floor() as usize).min(self.size - 2));
        let fraction = core::array::from_fn(|axis| position[axis] - low[axis] as f32);

        let c000 = self.at(low[0], low[1], low[2]);
        let c100 = self.at(low[0] + 1, low[1], low[2]);
        let c010 = self.at(low[0], low[1] + 1, low[2]);
        let c001 = self.at(low[0], low[1], low[2] + 1);
        let c110 = self.at(low[0] + 1, low[1] + 1, low[2]);
        let c101 = self.at(low[0] + 1, low[1], low[2] + 1);
        let c011 = self.at(low[0], low[1] + 1, low[2] + 1);
        let c111 = self.at(low[0] + 1, low[1] + 1, low[2] + 1);
        let [r, g, b] = fraction;

        if r >= g {
            if g >= b {
                combine(c000, [(c100, r), (c110, g), (c111, b)])
            } else if r >= b {
                combine(c000, [(c100, r), (c101, b), (c111, g)])
            } else {
                combine(c000, [(c001, b), (c101, r), (c111, g)])
            }
        } else if r >= b {
            combine(c000, [(c010, g), (c110, r), (c111, b)])
        } else if g >= b {
            combine(c000, [(c010, g), (c011, b), (c111, r)])
        } else {
            combine(c000, [(c001, b), (c011, g), (c111, r)])
        }
    }

    // The Python migration baseline performs coordinate and weight arithmetic
    // in f64 because colour-science exposes the CUBE domain as float64. Keep
    // this separate from the canonical f32 path so corrected-v2 stays lean.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::cast_sign_loss
    )]
    pub(crate) fn sample_legacy(&self, rgb: [f32; 3]) -> [f32; 3] {
        let scale = (self.size - 1) as f64;
        let position: [f64; 3] = core::array::from_fn(|axis| {
            let normalized = (f64::from(rgb[axis]) - f64::from(self.domain_min[axis]))
                / f64::from(self.domain_max[axis] - self.domain_min[axis]);
            normalized.clamp(0.0, 1.0) * scale
        });
        let low = position.map(|value| value as usize);
        let high = low.map(|value| (value + 1).min(self.size - 1));
        let [r, g, b] = core::array::from_fn(|axis| position[axis] - low[axis] as f64);
        let c000 = self.at(low[0], low[1], low[2]);
        let c111 = self.at(high[0], high[1], high[2]);

        if r >= g {
            if g >= b {
                weighted_sum([
                    (c000, 1.0 - r),
                    (self.at(high[0], low[1], low[2]), r - g),
                    (self.at(high[0], high[1], low[2]), g - b),
                    (c111, b),
                ])
            } else if r >= b {
                weighted_sum([
                    (c000, 1.0 - r),
                    (self.at(high[0], low[1], low[2]), r - b),
                    (self.at(high[0], low[1], high[2]), b - g),
                    (c111, g),
                ])
            } else {
                weighted_sum([
                    (c000, 1.0 - b),
                    (self.at(low[0], low[1], high[2]), b - r),
                    (self.at(high[0], low[1], high[2]), r - g),
                    (c111, g),
                ])
            }
        } else if b >= g {
            weighted_sum([
                (c000, 1.0 - b),
                (self.at(low[0], low[1], high[2]), b - g),
                (self.at(low[0], high[1], high[2]), g - r),
                (c111, r),
            ])
        } else if b >= r {
            weighted_sum([
                (c000, 1.0 - g),
                (self.at(low[0], high[1], low[2]), g - b),
                (self.at(low[0], high[1], high[2]), b - r),
                (c111, r),
            ])
        } else {
            weighted_sum([
                (c000, 1.0 - g),
                (self.at(low[0], high[1], low[2]), g - r),
                (self.at(high[0], high[1], low[2]), r - b),
                (c111, b),
            ])
        }
    }

    fn at(&self, red: usize, green: usize, blue: usize) -> [f32; 3] {
        self.samples[blue * self.size * self.size + green * self.size + red]
    }
}

#[allow(clippy::cast_possible_truncation)]
fn weighted_sum(vertices: [([f32; 3], f64); 4]) -> [f32; 3] {
    core::array::from_fn(|channel| {
        (f64::from(vertices[0].0[channel]) * vertices[0].1
            + f64::from(vertices[1].0[channel]) * vertices[1].1
            + f64::from(vertices[2].0[channel]) * vertices[2].1
            + f64::from(vertices[3].0[channel]) * vertices[3].1) as f32
    })
}

fn combine(origin: [f32; 3], vertices: [([f32; 3], f32); 3]) -> [f32; 3] {
    core::array::from_fn(|channel| {
        origin[channel]
            + vertices[0].1 * (vertices[0].0[channel] - origin[channel])
            + vertices[1].1 * (vertices[1].0[channel] - vertices[0].0[channel])
            + vertices[2].1 * (vertices[2].0[channel] - vertices[1].0[channel])
    })
}

fn parse_triplet(fields: &[&str], line: usize, label: &str) -> Result<[f32; 3]> {
    if fields.len() != if label == "sample" { 3 } else { 4 } {
        return invalid(line, &format!("{label} requires three values"));
    }
    let offset = usize::from(label != "sample");
    let mut values = [0.0; 3];
    for (target, source) in values.iter_mut().zip(&fields[offset..]) {
        *target = source
            .parse::<f32>()
            .map_err(|_| cube_error(line, &format!("invalid {label} value")))?;
        if !target.is_finite() {
            return invalid(line, &format!("{label} values must be finite"));
        }
    }
    Ok(values)
}

fn cube_error(line: usize, message: &str) -> AlchemyError {
    AlchemyError::InvalidCube {
        line,
        message: message.to_owned(),
    }
}

fn invalid<T>(line: usize, message: &str) -> Result<T> {
    Err(cube_error(line, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY_2: &str = r#"
TITLE "identity"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
"#;

    #[test]
    fn parses_red_fastest_and_interpolates_all_six_tetrahedra() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        for input in [
            [0.8, 0.5, 0.2],
            [0.8, 0.2, 0.5],
            [0.5, 0.2, 0.8],
            [0.5, 0.8, 0.2],
            [0.2, 0.8, 0.5],
            [0.2, 0.5, 0.8],
            [0.5, 0.5, 0.2],
            [0.2, 0.5, 0.5],
            [0.5, 0.2, 0.5],
        ] {
            let actual = lut.sample(input);
            for channel in 0..3 {
                assert!((actual[channel] - input[channel]).abs() < 2.0e-7);
            }
        }
    }

    #[test]
    fn clamps_at_lut_domain_only() {
        let lut = Lut3d::parse(IDENTITY_2).unwrap();
        let actual = lut.sample([-2.0, 0.4, 3.0]);
        for (actual, expected) in actual.into_iter().zip([0.0, 0.4, 1.0]) {
            assert!((actual - expected).abs() < 2.0e-7);
        }
    }

    #[test]
    fn accepts_scientific_notation() {
        let source = IDENTITY_2.replacen("1 0 0", "1e0 0e0 0e0", 1);
        let lut = Lut3d::parse(&source).unwrap();
        let actual = lut.sample([1.0, 0.0, 0.0]);
        for (actual, expected) in actual.into_iter().zip([1.0, 0.0, 0.0]) {
            assert!((actual - expected).abs() < f32::EPSILON);
        }
    }

    #[test]
    fn rejects_wrong_sample_count_and_non_finite_data() {
        let count_error = Lut3d::parse("LUT_3D_SIZE 2\n0 0 0\n").unwrap_err();
        assert!(matches!(
            count_error,
            AlchemyError::InvalidCubeSampleCount { .. }
        ));

        let nan = IDENTITY_2.replace("1 1 1", "NaN 1 1");
        assert!(matches!(
            Lut3d::parse(&nan).unwrap_err(),
            AlchemyError::InvalidCube { .. }
        ));
    }
}
