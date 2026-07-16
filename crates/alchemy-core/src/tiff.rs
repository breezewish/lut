use std::{io::Cursor, ops::Range};

use tiff_core::{
    ByteOrder, Compression, PhotometricInterpretation, PlanarConfiguration, Predictor,
};
use tiff_writer::{ImageBuilder, ImageHandle, TiffVariant, TiffWriter, WriteOptions};

use crate::{AlchemyError, Result};

const STRIP_TARGET_BYTES: u64 = 1_000_000;

pub(crate) struct Rgb16TiffWriter {
    writer: TiffWriter<Cursor<Vec<u8>>>,
    image: ImageHandle,
    row_samples: usize,
    height: u32,
    rows_per_strip: u32,
    strip_count: u32,
    next_strip: u32,
}

impl Rgb16TiffWriter {
    pub(crate) fn new(width: u32, height: u32) -> Result<Self> {
        if width == 0 || height == 0 {
            return Err(AlchemyError::EmptyImage);
        }
        let row_samples = (width as usize)
            .checked_mul(3)
            .ok_or(AlchemyError::ImageTooLarge)?;
        let row_bytes = u64::try_from(row_samples)
            .ok()
            .and_then(|samples| samples.checked_mul(size_of::<u16>() as u64))
            .ok_or(AlchemyError::ImageTooLarge)?;
        let rows_per_strip = u64::from(height)
            .min(STRIP_TARGET_BYTES.div_ceil(row_bytes))
            .try_into()
            .map_err(|_| AlchemyError::ImageTooLarge)?;

        let image = ImageBuilder::new(width, height)
            .samples_per_pixel(3)
            .sample_type::<u16>()
            .compression(Compression::Deflate)
            .predictor(Predictor::Horizontal)
            .photometric(PhotometricInterpretation::Rgb)
            .planar_configuration(PlanarConfiguration::Chunky)
            .strips(rows_per_strip);
        let options = WriteOptions {
            byte_order: ByteOrder::LittleEndian,
            variant: TiffVariant::Classic,
        };
        let mut writer = TiffWriter::new(Cursor::new(Vec::new()), options)
            .map_err(|error| AlchemyError::TiffEncoding(error.to_string()))?;
        let image = writer
            .add_image(image)
            .map_err(|error| AlchemyError::TiffEncoding(error.to_string()))?;

        Ok(Self {
            writer,
            image,
            row_samples,
            height,
            rows_per_strip,
            strip_count: height.div_ceil(rows_per_strip),
            next_strip: 0,
        })
    }

    pub(crate) fn next_strip_samples(&self) -> usize {
        if self.next_strip == self.strip_count {
            return 0;
        }
        let start_row = self.next_strip * self.rows_per_strip;
        let remaining_rows = self.height - start_row;
        let strip_rows = remaining_rows.min(self.rows_per_strip);
        strip_rows as usize * self.row_samples
    }

    pub(crate) fn write_strip(&mut self, samples: &[u16]) -> Result<()> {
        let expected = self.next_strip_samples();
        if expected == 0 || samples.len() != expected {
            return Err(AlchemyError::TiffEncoding(format!(
                "rendered strip contains {} samples; expected {expected}",
                samples.len()
            )));
        }
        self.writer
            .write_block(&self.image, self.next_strip as usize, samples)
            .map_err(|error| AlchemyError::TiffEncoding(error.to_string()))?;
        self.next_strip += 1;
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<Vec<u8>> {
        if self.next_strip != self.strip_count {
            return Err(AlchemyError::TiffEncoding(format!(
                "encoded {} of {} TIFF strips",
                self.next_strip, self.strip_count
            )));
        }
        self.writer
            .finish()
            .map(Cursor::into_inner)
            .map_err(|error| AlchemyError::TiffEncoding(error.to_string()))
    }
}

pub(crate) fn encode_rgb16_strips(
    width: u32,
    height: u32,
    mut render_strip: impl FnMut(Range<usize>, &mut Vec<u16>) -> Result<()>,
) -> Result<Vec<u8>> {
    let mut writer = Rgb16TiffWriter::new(width, height)?;
    let mut sample_offset = 0usize;
    let mut strip = Vec::new();
    loop {
        let sample_count = writer.next_strip_samples();
        if sample_count == 0 {
            break;
        }
        let sample_end = sample_offset
            .checked_add(sample_count)
            .ok_or(AlchemyError::ImageTooLarge)?;

        strip.clear();
        strip.reserve(sample_count);
        render_strip(sample_offset..sample_end, &mut strip)?;
        writer.write_strip(&strip)?;
        sample_offset = sample_end;
    }
    writer.finish()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use tiff::{
        decoder::{Decoder, DecodingResult},
        tags::CompressionMethod,
    };

    use super::*;

    #[test]
    fn encodes_multiple_deflate_strips_with_bounded_render_buffers() {
        const WIDTH: u32 = 1_000;
        const HEIGHT: u32 = 400;

        let mut ranges = Vec::new();
        let encoded = encode_rgb16_strips(WIDTH, HEIGHT, |range, output| {
            ranges.push(range.clone());
            output.extend(
                range.map(|index| u16::try_from(index % (usize::from(u16::MAX) + 1)).unwrap()),
            );
            Ok(())
        })
        .unwrap();

        assert!(ranges.len() > 1);
        assert_eq!(ranges.first().unwrap().start, 0);
        assert_eq!(
            ranges.last().unwrap().end,
            WIDTH as usize * HEIGHT as usize * 3
        );
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        assert!(ranges.iter().all(|range| range.len() * size_of::<u16>()
            <= usize::try_from(STRIP_TARGET_BYTES).unwrap()
                + WIDTH as usize * 3 * size_of::<u16>()));

        let mut decoder = Decoder::new(Cursor::new(encoded)).unwrap();
        assert_eq!(decoder.dimensions().unwrap(), (WIDTH, HEIGHT));
        assert_eq!(
            decoder
                .get_tag_unsigned::<u16>(tiff::tags::Tag::Compression)
                .unwrap(),
            CompressionMethod::Deflate.to_u16()
        );
        assert_eq!(
            decoder
                .get_tag_unsigned::<u16>(tiff::tags::Tag::Predictor)
                .unwrap(),
            2
        );
        assert_eq!(decoder.strip_count().unwrap() as usize, ranges.len());
        let DecodingResult::U16(pixels) = decoder.read_image().unwrap() else {
            panic!("TIFF did not decode to u16 samples");
        };
        assert_eq!(pixels.len(), WIDTH as usize * HEIGHT as usize * 3);
        for (index, sample) in pixels.into_iter().enumerate() {
            assert_eq!(
                sample,
                u16::try_from(index % (usize::from(u16::MAX) + 1)).unwrap()
            );
        }
    }
}
