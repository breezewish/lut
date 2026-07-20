use crate::{LutifyError, Result};

pub(crate) fn checked_pixel_count(width: u32, height: u32) -> Result<usize> {
    if width == 0 || height == 0 {
        return Err(LutifyError::EmptyImage);
    }
    (width as usize)
        .checked_mul(height as usize)
        .ok_or(LutifyError::ImageTooLarge)
}

#[cfg(any(test, all(feature = "wasm", target_arch = "wasm32")))]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub(crate) fn preview_dimensions(width: u32, height: u32, max_edge: u32) -> Result<(u32, u32)> {
    if max_edge == 0 {
        return Err(LutifyError::InvalidPreviewSize);
    }
    let scale = (f64::from(max_edge) / f64::from(width.max(height))).min(1.0);
    Ok((
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    ))
}

/// A display-sized RGB16 source assembled from bounded source-row transfers.
///
/// The browser decoder and color core have separate WASM memories. Keeping the
/// resampling coordinates here lets the Worker transfer only the source rows
/// that contribute to the preview while all pixel selection remains in Rust.
#[cfg(any(test, all(feature = "wasm", target_arch = "wasm32")))]
pub(crate) struct PreviewSource {
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
    next_output_row: u32,
    pixels: Vec<u16>,
}

#[cfg(any(test, all(feature = "wasm", target_arch = "wasm32")))]
impl PreviewSource {
    pub(crate) fn new(source_width: u32, source_height: u32, max_edge: u32) -> Result<Self> {
        checked_pixel_count(source_width, source_height)?;
        let (width, height) = preview_dimensions(source_width, source_height, max_edge)?;
        let output_samples = checked_pixel_count(width, height)?
            .checked_mul(3)
            .ok_or(LutifyError::ImageTooLarge)?;
        Ok(Self {
            source_width,
            source_height,
            width,
            height,
            next_output_row: 0,
            pixels: Vec::with_capacity(output_samples),
        })
    }

    #[allow(clippy::cast_possible_truncation)]
    pub(crate) fn next_source_row(&self) -> Option<u32> {
        (self.next_output_row < self.height).then(|| {
            (u64::from(self.next_output_row) * u64::from(self.source_height)
                / u64::from(self.height)) as u32
        })
    }

    pub(crate) fn write_source_row(&mut self, row: &[u16]) -> Result<()> {
        if self.next_output_row == self.height {
            return Err(LutifyError::InvalidPixelCount {
                actual: row.len(),
                expected: 0,
            });
        }
        let expected = (self.source_width as usize)
            .checked_mul(3)
            .ok_or(LutifyError::ImageTooLarge)?;
        if row.len() != expected {
            return Err(LutifyError::InvalidPixelCount {
                actual: row.len(),
                expected,
            });
        }

        for output_x in 0..self.width {
            let source_x =
                u64::from(output_x) * u64::from(self.source_width) / u64::from(self.width);
            let source = usize::try_from(source_x).map_err(|_| LutifyError::ImageTooLarge)? * 3;
            self.pixels.extend_from_slice(&row[source..source + 3]);
        }
        self.next_output_row += 1;
        Ok(())
    }

    pub(crate) fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub(crate) fn pixels(&self) -> Result<&[u16]> {
        let expected = checked_pixel_count(self.width, self.height)?
            .checked_mul(3)
            .ok_or(LutifyError::ImageTooLarge)?;
        if self.pixels.len() != expected {
            return Err(LutifyError::InvalidPixelCount {
                actual: self.pixels.len(),
                expected,
            });
        }
        Ok(&self.pixels)
    }

    pub(crate) fn take_pixels(&mut self) -> Result<Vec<u16>> {
        self.pixels()?;
        Ok(std::mem::take(&mut self.pixels))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_source_keeps_only_pixels_used_by_the_display_size() {
        let mut source = PreviewSource::new(4, 4, 2).unwrap();
        assert_eq!(source.dimensions(), (2, 2));
        assert_eq!(source.next_source_row(), Some(0));

        source
            .write_source_row(&[0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32])
            .unwrap();
        assert_eq!(source.next_source_row(), Some(2));
        source
            .write_source_row(&[200, 201, 202, 210, 211, 212, 220, 221, 222, 230, 231, 232])
            .unwrap();

        assert_eq!(source.next_source_row(), None);
        assert_eq!(
            source.pixels().unwrap(),
            &[0, 1, 2, 20, 21, 22, 200, 201, 202, 220, 221, 222]
        );

        let moved = source.take_pixels().unwrap();
        assert_eq!(moved.len(), 12);
        assert!(matches!(
            source.pixels(),
            Err(LutifyError::InvalidPixelCount {
                actual: 0,
                expected: 12
            })
        ));
    }

    #[test]
    fn preview_source_rejects_incomplete_and_inconsistent_rows() {
        let mut source = PreviewSource::new(4, 4, 2).unwrap();
        assert!(matches!(
            source.pixels(),
            Err(LutifyError::InvalidPixelCount {
                actual: 0,
                expected: 12
            })
        ));
        assert!(matches!(
            source.write_source_row(&[0; 11]),
            Err(LutifyError::InvalidPixelCount {
                actual: 11,
                expected: 12
            })
        ));

        source.write_source_row(&[0; 12]).unwrap();
        source.write_source_row(&[0; 12]).unwrap();
        assert!(matches!(
            source.write_source_row(&[0; 12]),
            Err(LutifyError::InvalidPixelCount {
                actual: 12,
                expected: 0
            })
        ));
    }
}
