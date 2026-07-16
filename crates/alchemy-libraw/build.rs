use std::env;
use std::path::{Path, PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let libraw = manifest.join("../../vendor/LibRaw");
    let version_header = libraw.join("libraw/libraw_version.h");
    assert!(
        version_header.exists(),
        "vendor/LibRaw is missing; run git submodule update --init --recursive"
    );

    let jpeg_source = manifest.join("../../vendor/libjpeg-turbo");
    assert!(
        jpeg_source.join("CMakeLists.txt").exists(),
        "vendor/libjpeg-turbo is missing; run git submodule update --init --recursive"
    );
    let jpeg = cmake::Config::new(&jpeg_source)
        .define("ENABLE_SHARED", "FALSE")
        .define("ENABLE_STATIC", "TRUE")
        .define("WITH_TURBOJPEG", "FALSE")
        .define("WITH_TOOLS", "FALSE")
        .define("WITH_TESTS", "FALSE")
        .define("WITH_JAVA", "FALSE")
        .build();

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        // Decode parity is a numerical contract. Keep LibRaw's compilation
        // profile stable even when Rust tests use an unoptimized profile.
        .opt_level(3)
        .flag("-ffp-contract=off")
        .include(&libraw)
        .include(jpeg.join("include"))
        .define("LIBRAW_NODLL", None)
        .define("USE_JPEG", None)
        .define("USE_JPEG8", None)
        .warnings(false)
        .file(manifest.join("src/wrapper.cpp"))
        .file(manifest.join("src/postprocessing_utils.cpp"));

    let pattern = libraw.join("src/**/*.cpp");
    for source in glob::glob(pattern.to_str().unwrap()).expect("valid LibRaw source glob") {
        let source = source.expect("readable LibRaw source path");
        if is_optional_integration(&source) {
            continue;
        }
        build.file(source);
    }
    build.compile("alchemy_libraw");

    println!(
        "cargo:rustc-link-search=native={}",
        jpeg.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=jpeg");

    println!(
        "cargo:rerun-if-changed={}",
        manifest.join("src/wrapper.cpp").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest.join("src/postprocessing_utils.cpp").display()
    );
    println!("cargo:rerun-if-changed={}", version_header.display());
}

fn is_optional_integration(path: &Path) -> bool {
    let path = path.to_string_lossy();
    path.contains("/integration/")
        || path.ends_with("/postprocessing_ph.cpp")
        || path.ends_with("/preprocessing_ph.cpp")
        || path.ends_with("/write_ph.cpp")
        || path.ends_with("/postprocessing/postprocessing_utils.cpp")
}
