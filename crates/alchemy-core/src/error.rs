use thiserror::Error;

/// Errors returned by the color-processing library.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AlchemyError {
    #[error("image dimensions must be non-zero")]
    EmptyImage,
    #[error("RGB16 input length is {actual}; expected {expected}")]
    InvalidPixelCount { actual: usize, expected: usize },
    #[error("image dimensions exceed the supported address space")]
    ImageTooLarge,
    #[error("EV must be finite and within -8..=8")]
    InvalidExposure,
    #[error("preview max edge must be non-zero")]
    InvalidPreviewSize,
    #[error("CUBE line {line}: {message}")]
    InvalidCube { line: usize, message: String },
    #[error("CUBE declares {actual} samples; expected {expected}")]
    InvalidCubeSampleCount { actual: usize, expected: usize },
    #[error("TIFF encoding failed: {0}")]
    TiffEncoding(String),
}

pub type Result<T> = std::result::Result<T, AlchemyError>;
