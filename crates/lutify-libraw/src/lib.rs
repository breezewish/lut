//! Safe, deliberately small wrapper around the pinned `LibRaw` decoder.

use std::ffi::{CStr, c_char, c_int};

/// Interleaved RGB16 decoded in `LibRaw` `ProPhoto` D65 Linear.
#[derive(Debug, PartialEq, Eq)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u16>,
}

/// Decodes a camera RAW buffer with parameters inherited from upstream RAW Alchemy.
///
/// # Errors
///
/// Returns a descriptive `LibRaw` error when the file is corrupt, unsupported,
/// or cannot be processed as 16-bit RGB.
pub fn decode(bytes: &[u8], half_size: bool) -> Result<DecodedImage, String> {
    let mut output = NativeImage::default();
    // SAFETY: `bytes` remains alive for the synchronous call and `output`
    // points to writable storage with the exact C layout.
    let status =
        unsafe { lutify_libraw_decode(bytes.as_ptr(), bytes.len(), half_size, &raw mut output) };
    if status != 0 {
        // SAFETY: the C wrapper always zero-initializes and terminates `error`.
        let message = unsafe { CStr::from_ptr(output.error.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        return Err(if message.is_empty() {
            format!("LibRaw decoding failed with code {status}")
        } else {
            message
        });
    }
    if output.pixels.is_null() {
        return Err("LibRaw returned no pixel buffer".to_owned());
    }
    // SAFETY: the wrapper allocated `pixel_count` initialized u16 values and
    // retains ownership until the paired free call below.
    let pixels = unsafe { std::slice::from_raw_parts(output.pixels, output.pixel_count) }.to_vec();
    // SAFETY: exactly the pointer returned by the wrapper, freed once.
    unsafe { lutify_libraw_free(output.pixels) };

    let expected = usize::try_from(output.width)
        .ok()
        .and_then(|width| {
            usize::try_from(output.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or_else(|| "decoded image dimensions overflow the address space".to_owned())?;
    if pixels.len() != expected {
        return Err(format!(
            "LibRaw returned {} samples for a {} × {} RGB image",
            pixels.len(),
            output.width,
            output.height
        ));
    }
    Ok(DecodedImage {
        width: output.width,
        height: output.height,
        pixels,
    })
}

/// Returns the exact linked `LibRaw` version.
#[must_use]
pub fn version() -> String {
    // SAFETY: LibRaw returns a process-lifetime, null-terminated version string.
    unsafe { CStr::from_ptr(lutify_libraw_version()) }
        .to_string_lossy()
        .into_owned()
}

#[repr(C)]
struct NativeImage {
    width: u32,
    height: u32,
    pixels: *mut u16,
    pixel_count: usize,
    error: [c_char; 256],
}

impl Default for NativeImage {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            pixels: std::ptr::null_mut(),
            pixel_count: 0,
            error: [0; 256],
        }
    }
}

unsafe extern "C" {
    fn lutify_libraw_decode(
        bytes: *const u8,
        length: usize,
        half_size: bool,
        output: *mut NativeImage,
    ) -> c_int;
    fn lutify_libraw_free(pixels: *mut u16);
    fn lutify_libraw_version() -> *const c_char;
}
