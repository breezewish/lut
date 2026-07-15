//! Test utility that writes a self-describing little-endian RGB16 buffer.

use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let input_path = arguments.next().ok_or("missing input RAW path")?;
    let output_path = arguments.next().ok_or("missing output path")?;
    if arguments.next().is_some() {
        return Err("expected exactly an input RAW path and output path".into());
    }

    let input = std::fs::read(input_path)?;
    let image = alchemy_libraw::decode(&input, false)?;
    let mut output = std::io::BufWriter::new(std::fs::File::create(output_path)?);
    output.write_all(&image.width.to_le_bytes())?;
    output.write_all(&image.height.to_le_bytes())?;
    for sample in image.pixels {
        output.write_all(&sample.to_le_bytes())?;
    }
    Ok(())
}
