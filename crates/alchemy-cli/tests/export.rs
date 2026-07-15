use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

use tiff::ColorType;
use tiff::decoder::{Decoder, DecodingResult};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn exports_real_dng_to_rgb16_tiff_and_json() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("output.tif");
    let result = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(root().join("vendor/LibRaw-Wasm/test/integration/lossy.dng"))
        .arg(&destination)
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--output")
        .arg("json")
        .output()
        .unwrap();

    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["status"], "ok");
    assert_eq!(report["width"], 256);
    assert_eq!(report["height"], 168);
    assert_eq!(report["libraw"], "0.22.0-Release");

    let bytes = std::fs::read(destination).unwrap();
    let mut decoder = Decoder::new(Cursor::new(bytes)).unwrap();
    assert_eq!(decoder.dimensions().unwrap(), (256, 168));
    assert_eq!(decoder.colortype().unwrap(), ColorType::RGB(16));
    let DecodingResult::U16(pixels) = decoder.read_image().unwrap() else {
        panic!("TIFF did not decode to u16 samples");
    };
    assert_eq!(pixels.len(), 256 * 168 * 3);
}

#[test]
fn corrupt_raw_fails_without_creating_output() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("broken.dng");
    let destination = directory.path().join("output.tif");
    std::fs::write(&source, b"not a raw file").unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(source)
        .arg(&destination)
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--json")
        .output()
        .unwrap();

    assert!(!result.status.success());
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["status"], "error");
    assert!(!destination.exists());
}
