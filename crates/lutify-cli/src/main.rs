use std::io::IsTerminal;
use std::path::PathBuf;

use clap::{Parser, ValueEnum};
use lutify_core::{ColorPipeline, Lut3d, WhiteBalance};

#[derive(Debug, Parser)]
#[command(name = "lutify", about = "Apply a V-Log Alchemy look to a camera RAW")]
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
    /// Relative warm/cool adjustment; zero preserves As Shot.
    #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
    temperature: f32,
    /// Relative green/magenta adjustment; zero preserves As Shot.
    #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
    tint: f32,
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

impl Color {
    fn enabled(self, is_terminal: bool) -> bool {
        match self {
            Self::Auto => is_terminal,
            Self::Always => true,
            Self::Never => false,
        }
    }
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
            Output::Text => {
                let heading = if args.color.enabled(std::io::stderr().is_terminal()) {
                    "\x1b[31;1mCould not export RAW\x1b[0m"
                } else {
                    "Could not export RAW"
                };
                eprintln!("{heading}: {error}");
            }
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
    let white_balance =
        WhiteBalance::new(args.temperature, args.tint).map_err(|error| error.to_string())?;
    let pipeline =
        ColorPipeline::new(args.ev, white_balance, lut).map_err(|error| error.to_string())?;
    let decoded = lutify_libraw::decode(&input, false).map_err(|_| {
        format!(
            "could not decode {}: the file may be damaged or its camera format may not be supported yet",
            args.input.display()
        )
    })?;
    let tiff = pipeline
        .render_tiff(&decoded.pixels, decoded.width, decoded.height)
        .map_err(|error| error.to_string())?;
    std::fs::write(&args.destination, tiff)
        .map_err(|error| format!("could not write {}: {error}", args.destination.display()))?;

    let libraw = lutify_libraw::version();
    match output {
        Output::Json => println!(
            "{}",
            serde_json::json!({
                "status": "ok",
                "destination": args.destination.to_string_lossy(),
                "width": decoded.width,
                "height": decoded.height,
                "pipeline": "corrected-v2",
                "libraw": libraw,
            })
        ),
        Output::Text => {
            let color = args.color.enabled(std::io::stdout().is_terminal());
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
