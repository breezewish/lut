use std::io::IsTerminal;
use std::path::PathBuf;

use alchemy_core::{ColorPipeline, Lut3d, ProcessingMode};
use clap::{Parser, ValueEnum};
use serde::Serialize;

#[derive(Debug, Parser)]
#[command(name = "alchemy", about = "Apply a V-Log Alchemy look to a camera RAW")]
struct Args {
    /// Camera RAW to process.
    input: PathBuf,
    /// Destination 16-bit TIFF.
    destination: PathBuf,
    /// V-Log Alchemy CUBE look.
    #[arg(long)]
    lut: PathBuf,
    /// Exposure adjustment in stops.
    #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
    ev: f32,
    /// Message rendering format.
    #[arg(long, value_enum, default_value_t = Output::Text)]
    output: Output,
    /// Convenience alias for --output json.
    #[arg(long, conflicts_with = "output")]
    json: bool,
    /// ANSI color policy for text messages.
    #[arg(long, value_enum, default_value_t = Color::Auto)]
    color: Color,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Output {
    Text,
    Json,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Color {
    Auto,
    Always,
    Never,
}

#[derive(Serialize)]
struct Success<'a> {
    status: &'static str,
    destination: &'a std::path::Path,
    width: u32,
    height: u32,
    pipeline: &'static str,
    libraw: &'a str,
}

fn main() {
    let args = Args::parse();
    let output = if args.json { Output::Json } else { args.output };
    if let Err(error) = run(&args, output) {
        match output {
            Output::Json => println!(
                "{}",
                serde_json::json!({ "status": "error", "message": error })
            ),
            Output::Text => eprintln!("Could not export RAW: {error}"),
        }
        std::process::exit(1);
    }
}

fn run(args: &Args, output: Output) -> Result<(), String> {
    let input = std::fs::read(&args.input)
        .map_err(|error| format!("could not read {}: {error}", args.input.display()))?;
    let cube = std::fs::read_to_string(&args.lut)
        .map_err(|error| format!("could not read {}: {error}", args.lut.display()))?;
    let lut = Lut3d::parse(&cube).map_err(|error| error.to_string())?;
    let pipeline = ColorPipeline::new(args.ev, ProcessingMode::CorrectedV2, lut)
        .map_err(|error| error.to_string())?;
    let decoded = alchemy_libraw::decode(&input, false)?;
    let tiff = pipeline
        .render_tiff(&decoded.pixels, decoded.width, decoded.height)
        .map_err(|error| error.to_string())?;
    std::fs::write(&args.destination, tiff)
        .map_err(|error| format!("could not write {}: {error}", args.destination.display()))?;

    let libraw = alchemy_libraw::version();
    let success = Success {
        status: "ok",
        destination: &args.destination,
        width: decoded.width,
        height: decoded.height,
        pipeline: "corrected-v2",
        libraw: &libraw,
    };
    match output {
        Output::Json => println!("{}", serde_json::to_string_pretty(&success).unwrap()),
        Output::Text => {
            let color = match args.color {
                Color::Auto => std::io::stdout().is_terminal(),
                Color::Always => true,
                Color::Never => false,
            };
            let heading = if color {
                "\x1b[32;1mExport complete\x1b[0m"
            } else {
                "Export complete"
            };
            println!("{heading}");
            println!(
                "{} × {} · 16-bit TIFF · corrected-v2",
                decoded.width, decoded.height
            );
            println!("Saved to {}", args.destination.display());
        }
    }
    Ok(())
}
