use std::ffi::{c_char, c_int};

use crate::{ColorPipeline, Lut3d, LutifyError, WhiteBalance};

/// Stable status values returned by the C ABI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum LutifyStatus {
    Ok = 0,
    InvalidArgument = 1,
    InvalidCube = 2,
    InvalidImage = 3,
    InvalidExposure = 4,
    EncodingFailed = 5,
    InvalidWhiteBalance = 6,
}

/// A Rust-owned byte allocation returned through the C ABI.
///
/// Call [`lutify_free_buffer`] exactly once when `data` is non-null. Callers
/// must not modify any field before releasing the buffer.
#[derive(Debug)]
#[repr(C)]
pub struct LutifyBuffer {
    pub data: *mut u8,
    pub len: usize,
    pub capacity: usize,
}

/// Result of a C ABI render operation.
#[derive(Debug)]
#[repr(C)]
pub struct LutifyRenderResult {
    pub status: LutifyStatus,
    pub buffer: LutifyBuffer,
}

/// Renders corrected-v2 RGB16 TIFF bytes through the stable C ABI.
///
/// `cube` must contain one UTF-8 3D CUBE document. On success, ownership of
/// `buffer` passes to the caller and must be returned with
/// [`lutify_free_buffer`].
///
/// # Safety
///
/// `pixels` must point to `pixel_len` initialized `u16` values and `cube` must
/// point to `cube_len` initialized bytes. Both allocations must remain valid
/// for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lutify_render_tiff_v2(
    pixels: *const u16,
    pixel_len: usize,
    width: u32,
    height: u32,
    ev: f32,
    temperature: f32,
    tint: f32,
    cube: *const u8,
    cube_len: usize,
) -> LutifyRenderResult {
    if pixels.is_null() || cube.is_null() {
        return failed(LutifyStatus::InvalidArgument);
    }

    // SAFETY: validity is the caller's contract documented above; null was
    // rejected before constructing either slice.
    let pixels = unsafe { std::slice::from_raw_parts(pixels, pixel_len) };
    // SAFETY: same contract as `pixels`.
    let cube = unsafe { std::slice::from_raw_parts(cube, cube_len) };
    let Ok(cube) = std::str::from_utf8(cube) else {
        return failed(LutifyStatus::InvalidArgument);
    };

    let lut = match Lut3d::parse(cube) {
        Ok(lut) => lut,
        Err(error) => return failed(status_for(&error)),
    };
    let white_balance = match WhiteBalance::new(temperature, tint) {
        Ok(white_balance) => white_balance,
        Err(error) => return failed(status_for(&error)),
    };
    let pipeline = match ColorPipeline::new(ev, white_balance, lut) {
        Ok(pipeline) => pipeline,
        Err(error) => return failed(status_for(&error)),
    };
    let bytes = match pipeline.render_tiff(pixels, width, height) {
        Ok(bytes) => bytes,
        Err(error) => return failed(status_for(&error)),
    };
    LutifyRenderResult {
        status: LutifyStatus::Ok,
        buffer: into_buffer(bytes),
    }
}

/// Releases a buffer returned by [`lutify_render_tiff_v2`].
///
/// Passing the all-zero buffer from a failed result is a no-op.
///
/// # Safety
///
/// The fields must be unchanged from a buffer returned by this library, and
/// the buffer must not have been freed before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lutify_free_buffer(buffer: LutifyBuffer) {
    if buffer.data.is_null() {
        return;
    }
    // SAFETY: ownership and exact allocation layout are the caller's contract.
    drop(unsafe { Vec::from_raw_parts(buffer.data, buffer.len, buffer.capacity) });
}

/// Returns a process-lifetime English description for a stable status code.
#[unsafe(no_mangle)]
pub extern "C" fn lutify_status_message(status: c_int) -> *const c_char {
    let message: &'static [u8] = match status {
        0 => b"ok\0",
        1 => b"invalid pointer, length, or UTF-8 input\0",
        2 => b"invalid 3D CUBE document\0",
        3 => b"invalid image dimensions or RGB16 length\0",
        4 => b"invalid exposure\0",
        5 => b"TIFF encoding failed\0",
        6 => b"invalid white balance\0",
        _ => b"unknown LUTify status\0",
    };
    message.as_ptr().cast()
}

fn into_buffer(mut bytes: Vec<u8>) -> LutifyBuffer {
    let buffer = LutifyBuffer {
        data: bytes.as_mut_ptr(),
        len: bytes.len(),
        capacity: bytes.capacity(),
    };
    std::mem::forget(bytes);
    buffer
}

fn failed(status: LutifyStatus) -> LutifyRenderResult {
    LutifyRenderResult {
        status,
        buffer: LutifyBuffer {
            data: std::ptr::null_mut(),
            len: 0,
            capacity: 0,
        },
    }
}

fn status_for(error: &LutifyError) -> LutifyStatus {
    match error {
        LutifyError::InvalidCube { .. } | LutifyError::InvalidCubeSampleCount { .. } => {
            LutifyStatus::InvalidCube
        }
        LutifyError::InvalidExposure => LutifyStatus::InvalidExposure,
        LutifyError::InvalidWhiteBalance => LutifyStatus::InvalidWhiteBalance,
        LutifyError::TiffEncoding(_) => LutifyStatus::EncodingFailed,
        LutifyError::EmptyImage
        | LutifyError::InvalidPixelCount { .. }
        | LutifyError::ImageTooLarge
        | LutifyError::InvalidPreviewSize => LutifyStatus::InvalidImage,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: &str =
        "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";

    #[test]
    fn c_api_renders_and_releases_owned_tiff() {
        let pixels = [0_u16, 32_768, 65_535];
        // SAFETY: both slices remain valid for the complete call.
        let result = unsafe {
            lutify_render_tiff_v2(
                pixels.as_ptr(),
                pixels.len(),
                1,
                1,
                0.0,
                0.0,
                0.0,
                IDENTITY.as_ptr(),
                IDENTITY.len(),
            )
        };
        assert_eq!(result.status, LutifyStatus::Ok);
        assert!(!result.buffer.data.is_null());
        assert!(result.buffer.len > 8);
        // SAFETY: this is the unchanged buffer returned above and is freed once.
        unsafe { lutify_free_buffer(result.buffer) };
    }

    #[test]
    fn c_api_rejects_null_input_without_allocating() {
        // SAFETY: null is deliberately passed to verify boundary validation.
        let result = unsafe {
            lutify_render_tiff_v2(
                std::ptr::null(),
                0,
                1,
                1,
                0.0,
                0.0,
                0.0,
                IDENTITY.as_ptr(),
                IDENTITY.len(),
            )
        };
        assert_eq!(result.status, LutifyStatus::InvalidArgument);
        assert!(result.buffer.data.is_null());
    }
}
