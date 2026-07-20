export interface EmbeddedThumbnail {
  width: number;
  height: number;
  format: "jpeg" | "bitmap" | "unknown";
  data: Uint8Array<ArrayBuffer>;
}

/** Converts LibRaw's supported embedded-thumbnail layouts to JPEG bytes. */
export async function encodeEmbeddedThumbnail(
  thumbnail: EmbeddedThumbnail,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (thumbnail.format === "jpeg") return thumbnail.data;
  if (thumbnail.format !== "bitmap") return undefined;
  if (thumbnail.data.length !== thumbnail.width * thumbnail.height * 3) {
    throw new Error("The embedded camera thumbnail has invalid RGB data.");
  }
  const rgba = new Uint8ClampedArray(thumbnail.width * thumbnail.height * 4);
  for (
    let source = 0, destination = 0;
    source < thumbnail.data.length;
    source += 3, destination += 4
  ) {
    rgba[destination] = thumbnail.data[source];
    rgba[destination + 1] = thumbnail.data[source + 1];
    rgba[destination + 2] = thumbnail.data[source + 2];
    rgba[destination + 3] = 255;
  }
  const canvas = new OffscreenCanvas(thumbnail.width, thumbnail.height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The embedded camera thumbnail could not be encoded.");
  }
  context.putImageData(
    new ImageData(rgba, thumbnail.width, thumbnail.height),
    0,
    0,
  );
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return new Uint8Array(await blob.arrayBuffer());
}
