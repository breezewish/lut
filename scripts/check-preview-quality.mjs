import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import createLibRaw from "../web/src/libraw/libraw.js";
import { initSync, WasmLut } from "../web/src/wasm/alchemy_core.js";

const MAX_EDGE = 1_024;
const fixtures = [
  { name: "Linear DNG", path: "tests/fixtures/linear.dng" },
  {
    name: "Lossy Linear DNG",
    path: "vendor/LibRaw-Wasm/test/integration/lossy.dng",
  },
  {
    name: "Leica M8 Bayer DNG",
    path: "tests/fixtures/leica-m8.dng",
    crop: [1_500, 900, 1_000, 800],
  },
  {
    name: "Leica M8 rotated Bayer DNG",
    path: "tests/fixtures/leica-m8.dng",
    orientation: 6,
    crop: [900, 1_500, 800, 1_000],
  },
  {
    name: "Sony ILME-FX30 Bayer ARW",
    path: "vendor/LibRaw-Wasm/example-sony.ARW",
    crop: [2_400, 1_500, 1_400, 1_000],
  },
];
if (process.env.XTRANS_FIXTURE) {
  fixtures.push({
    name: "Fujifilm X-Trans RAF",
    path: process.env.XTRANS_FIXTURE,
    crop: [1_800, 1_100, 1_200, 900],
  });
}
const root = resolve(import.meta.dirname, "..");
const libraw = await createLibRaw({
  wasmBinary: await readFile(resolve(root, "web/src/libraw/libraw.wasm")),
});
initSync({
  module: await readFile(resolve(root, "web/src/wasm/alchemy_core_bg.wasm")),
});
const lut = new WasmLut(
  await readFile(resolve(root, "web/public/luts/fuji-provia.ralut")),
);

if (process.env.UNSUPPORTED_FUJI_FIXTURE) {
  const raw = new libraw.LibRaw();
  try {
    raw.openPreview(
      new Uint8Array(
        await readFile(resolve(root, process.env.UNSUPPORTED_FUJI_FIXTURE)),
      ),
      MAX_EDGE,
    );
    throw new Error("Legacy Fujifilm Super CCD Preview unexpectedly opened");
  } catch (error) {
    if (typeof error !== "object" || error === null || !("excPtr" in error)) {
      throw error;
    }
    const [, message] = libraw.getExceptionMessage(error);
    libraw.decrementExceptionRefcount(error);
    if (!message.includes("cannot be previewed reliably"))
      throw new Error(message);
    console.log(
      JSON.stringify({ name: "Legacy Fujifilm Super CCD RAF", error: message }),
    );
  } finally {
    raw.delete();
  }
}

const report = [];
const outputDirectory = process.env.PREVIEW_QUALITY_OUTPUT;
if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
for (const fixture of fixtures) {
  let bytes = new Uint8Array(await readFile(resolve(root, fixture.path)));
  if (fixture.orientation) {
    bytes = withTiffOrientation(bytes, fixture.orientation);
  }

  const exact = decodeExactDisplaySource(libraw, bytes);
  const preview = decodePreviewSource(libraw, bytes);
  if (preview.width !== exact.width || preview.height !== exact.height) {
    throw new Error(
      `${fixture.name} preview is ${preview.width}x${preview.height}; exact display source is ${exact.width}x${exact.height}`,
    );
  }
  const linear = compareChannels(exact.pixels, preview.pixels, 65_535);
  const exactDisplay = renderBase(lut, exact);
  const previewDisplay = renderBase(lut, preview);
  const display = compareChannels(exactDisplay, previewDisplay, 255, 4);
  const result = {
    name: fixture.name,
    dimensions: [preview.width, preview.height],
    exactDimensions: [exact.width, exact.height],
    linear,
    display,
  };
  report.push(result);
  console.log(JSON.stringify(result));

  if (outputDirectory && fixture.crop) {
    const crop = fixture.crop.map((value, index) =>
      Math.round(
        (value * (index % 2 === 0 ? preview.width : preview.height)) /
          (index % 2 === 0 ? exact.sourceWidth : exact.sourceHeight),
      ),
    );
    const stem = fixture.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
    await Promise.all([
      writePpmCrop(
        join(outputDirectory, `${stem}-export.ppm`),
        exactDisplay,
        preview.width,
        preview.height,
        crop,
      ),
      writePpmCrop(
        join(outputDirectory, `${stem}-preview.ppm`),
        previewDisplay,
        preview.width,
        preview.height,
        crop,
      ),
    ]);
  }

  // These limits were derived from the Bayer and X-Trans fixture
  // distributions. Mean and signed display differences constrain visible
  // color/exposure drift; p99 permits localized demosaic detail differences.
  if (
    display.meanAbsoluteDifference > 12 ||
    display.p99AbsoluteDifference > 80 ||
    display.meanSignedDifference.some((value) => Math.abs(value) > 2)
  ) {
    throw new Error(`${fixture.name} exceeds the preview quality contract`);
  }
}

const completeReport = { schemaVersion: 1, fixtures: report };
console.log(JSON.stringify(completeReport, null, 2));
if (outputDirectory) {
  await writeFile(
    join(outputDirectory, "preview-quality.json"),
    `${JSON.stringify(completeReport, null, 2)}\n`,
  );
}
lut.free();

function decodeExactDisplaySource(module, bytes) {
  const raw = new module.LibRaw();
  try {
    raw.open(bytes, false);
    const image = raw.imageInfo();
    const [width, height] = previewDimensions(
      image.width,
      image.height,
      MAX_EDGE,
    );
    const pixels = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.floor((y * image.height) / height);
      const row = raw.imageView(sourceY * image.width * 3, image.width * 3);
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.floor((x * image.width) / width);
        pixels.set(
          row.subarray(sourceX * 3, sourceX * 3 + 3),
          (y * width + x) * 3,
        );
      }
    }
    return {
      sourceWidth: image.width,
      sourceHeight: image.height,
      width,
      height,
      pixels,
    };
  } finally {
    raw.delete();
  }
}

function decodePreviewSource(module, bytes) {
  const raw = new module.LibRaw();
  try {
    raw.openPreview(bytes, MAX_EDGE);
    const image = raw.imageInfo();
    const [width, height] = previewDimensions(
      image.width,
      image.height,
      MAX_EDGE,
    );
    const pixels = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.floor((y * image.height) / height);
      const row = raw.imageView(sourceY * image.width * 3, image.width * 3);
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.floor((x * image.width) / width);
        pixels.set(
          row.subarray(sourceX * 3, sourceX * 3 + 3),
          (y * width + x) * 3,
        );
      }
    }
    return {
      width,
      height,
      pixels,
    };
  } finally {
    raw.delete();
  }
}

function renderBase(parsedLut, source) {
  const renderer = parsedLut.create_preview_renderer(
    source.width,
    source.height,
    MAX_EDGE,
  );
  try {
    const rowSamples = source.width * 3;
    while (true) {
      const row = renderer.next_source_row();
      if (row === undefined) break;
      renderer.write_source_row(
        source.pixels.subarray(row * rowSamples, (row + 1) * rowSamples),
      );
    }
    const rendered = renderer.render(0, MAX_EDGE, true);
    try {
      return rendered.take_base_rgba();
    } finally {
      rendered.free();
    }
  } finally {
    renderer.free();
  }
}

function compareChannels(left, right, maximum, stride = 3) {
  if (left.length !== right.length) {
    throw new Error(
      `Compared buffers have different lengths: ${left.length} and ${right.length}`,
    );
  }
  const histogram = new Uint32Array(maximum + 1);
  const signed = [0, 0, 0];
  let samples = 0;
  let absoluteTotal = 0;
  let maximumDifference = 0;
  for (let index = 0; index < left.length; index += stride) {
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = right[index + channel] - left[index + channel];
      const absolute = Math.abs(difference);
      signed[channel] += difference;
      absoluteTotal += absolute;
      maximumDifference = Math.max(maximumDifference, absolute);
      histogram[absolute] += 1;
      samples += 1;
    }
  }
  return {
    meanAbsoluteDifference: absoluteTotal / samples,
    p95AbsoluteDifference: percentile(histogram, samples, 0.95),
    p99AbsoluteDifference: percentile(histogram, samples, 0.99),
    maximumAbsoluteDifference: maximumDifference,
    meanSignedDifference: signed.map((value) => value / (samples / 3)),
  };
}

function percentile(histogram, samples, quantile) {
  const threshold = Math.ceil(samples * quantile);
  let total = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    total += histogram[value];
    if (total >= threshold) return value;
  }
  throw new Error("Could not calculate histogram percentile");
}

function previewDimensions(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
}

function withTiffOrientation(source, orientation) {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = String.fromCharCode(bytes[0], bytes[1]) === "II";
  const ifdOffset = view.getUint32(4, littleEndian);
  const entries = view.getUint16(ifdOffset, littleEndian);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (view.getUint16(entry, littleEndian) !== 274) continue;
    view.setUint16(entry + 8, orientation, littleEndian);
    return bytes;
  }
  throw new Error("The rotated quality fixture has no TIFF orientation tag");
}

async function writePpmCrop(path, rgba, width, height, crop) {
  const [cropX, cropY, cropWidth, cropHeight] = crop;
  if (
    cropX < 0 ||
    cropY < 0 ||
    cropX + cropWidth > width ||
    cropY + cropHeight > height
  ) {
    throw new Error(`Quality crop exceeds ${width}x${height}`);
  }
  const header = Buffer.from(`P6\n${cropWidth} ${cropHeight}\n255\n`);
  const rgb = Buffer.alloc(cropWidth * cropHeight * 3);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const source = ((cropY + y) * width + cropX + x) * 4;
      const target = (y * cropWidth + x) * 3;
      rgb[target] = rgba[source];
      rgb[target + 1] = rgba[source + 1];
      rgb[target + 2] = rgba[source + 2];
    }
  }
  await writeFile(path, Buffer.concat([header, rgb]));
}
