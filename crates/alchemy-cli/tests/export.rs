use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;

#[cfg(unix)]
use std::ffi::OsString;
#[cfg(unix)]
use std::os::unix::ffi::OsStringExt;

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
        .arg("--color")
        .arg("always")
        .output()
        .unwrap();

    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!result.stdout.contains(&0x1b));
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

#[cfg(unix)]
#[test]
fn json_export_supports_non_utf8_destination_paths() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory
        .path()
        .join(OsString::from_vec(b"output-\xff.tif".to_vec()));
    let result = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(root().join("tests/fixtures/linear.dng"))
        .arg(&destination)
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--json")
        .output()
        .unwrap();

    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["status"], "ok");
    assert!(destination.exists());
}

#[test]
fn corrupt_raw_fails_without_creating_output() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("broken.dng");
    let destination = directory.path().join("output.tif");
    std::fs::write(&source, b"not a raw file").unwrap();

    let result = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(&source)
        .arg(&destination)
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--json")
        .output()
        .unwrap();

    assert!(!result.status.success());
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["status"], "error");
    assert_eq!(
        report["message"],
        format!(
            "could not decode {}: the file may be damaged or its camera format may not be supported yet",
            source.display()
        )
    );
    assert!(!result.stdout.windows(6).any(|window| window == b"LibRaw"));
    assert!(!destination.exists());
}

#[test]
fn write_failure_is_structured_and_creates_no_output() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("missing/output.tif");
    let result = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(root().join("tests/fixtures/linear.dng"))
        .arg(&destination)
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--json")
        .output()
        .unwrap();

    assert!(!result.status.success());
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["status"], "error");
    assert!(
        report["message"]
            .as_str()
            .unwrap()
            .contains("could not write")
    );
    assert!(!destination.exists());
}

#[test]
fn text_color_policy_controls_ansi() {
    let directory = tempfile::tempdir().unwrap();
    let always = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(root().join("tests/fixtures/linear.dng"))
        .arg(directory.path().join("always.tif"))
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--color")
        .arg("always")
        .output()
        .unwrap();
    assert!(always.status.success());
    assert!(always.stdout.contains(&0x1b));

    let never = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(root().join("tests/fixtures/linear.dng"))
        .arg(directory.path().join("never.tif"))
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--color")
        .arg("never")
        .output()
        .unwrap();
    assert!(never.status.success());
    assert!(!never.stdout.contains(&0x1b));

    let error_always = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(directory.path().join("missing.dng"))
        .arg(directory.path().join("error-always.tif"))
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--color")
        .arg("always")
        .output()
        .unwrap();
    assert!(!error_always.status.success());
    assert!(error_always.stderr.contains(&0x1b));

    let error_never = Command::new(env!("CARGO_BIN_EXE_alchemy"))
        .arg(directory.path().join("missing.dng"))
        .arg(directory.path().join("error-never.tif"))
        .arg("--lut")
        .arg(root().join("tests/fixtures/identity.cube"))
        .arg("--color")
        .arg("never")
        .output()
        .unwrap();
    assert!(!error_never.status.success());
    assert!(!error_never.stderr.contains(&0x1b));
}
