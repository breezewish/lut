import { useEffect, useRef } from "react";

export function PreviewCanvas({
  label,
  detail,
  pixels,
  width,
  height,
}: {
  label: string;
  detail: string;
  pixels?: Uint8Array<ArrayBuffer>;
  width?: number;
  height?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvas.current || !pixels || !width || !height) return;
    const context = canvas.current.getContext("2d", { alpha: false });
    if (!context) return;
    canvas.current.width = width;
    canvas.current.height = height;
    const clamped = new Uint8ClampedArray(
      pixels.buffer,
      pixels.byteOffset,
      pixels.byteLength,
    );
    const drawStartedAt = performance.now();
    context.putImageData(new ImageData(clamped, width, height), 0, 0);
    performance.mark("raw-alchemy:canvas-draw", {
      detail: {
        label,
        width,
        height,
        durationMs: performance.now() - drawStartedAt,
      },
    });
  }, [label, pixels, width, height]);

  return (
    <figure className="preview-pane">
      <figcaption className="preview-caption">
        <strong>{label}</strong>
        <span>{detail}</span>
      </figcaption>
      <div className="preview-image">
        {pixels ? (
          <canvas ref={canvas} role="img" aria-label={`${label} preview`} />
        ) : (
          <div className="preview-placeholder" aria-hidden="true" />
        )}
      </div>
    </figure>
  );
}
