use std::io::Cursor;

use tiff::encoder::{DeflateLevel, TiffEncoder, colortype};

use crate::{AlchemyError, Result};

pub(crate) fn encode_rgb16(width: u32, height: u32, pixels: &[u16]) -> Result<Vec<u8>> {
    let mut cursor = Cursor::new(Vec::new());
    let mut encoder = TiffEncoder::new(&mut cursor)
        .map_err(|error| AlchemyError::TiffEncoding(error.to_string()))?
        .with_compression(tiff::encoder::Compression::Deflate(DeflateLevel::Balanced));
    encoder
        .write_image::<colortype::RGB16>(width, height, pixels)
        .map_err(|error| AlchemyError::TiffEncoding(error.to_string()))?;
    Ok(cursor.into_inner())
}
