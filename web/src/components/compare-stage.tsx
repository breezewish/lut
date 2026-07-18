import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronsLeftRight } from "lucide-react";

export interface StageImage {
  pixels: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
}

export type CompareMode = "wipe" | "split";

/**
 * Paints an RGBA buffer into a canvas exactly once, wrapping the transferred
 * bytes without a second full copy (the `Uint8ClampedArray` view shares the
 * source `ArrayBuffer`). Returns the canvas ref to mount.
 */
function useCanvasImage(image: StageImage | undefined) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !image) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const clamped = new Uint8ClampedArray(
      image.pixels.buffer,
      image.pixels.byteOffset,
      image.pixels.byteLength,
    );
    context.putImageData(
      new ImageData(clamped, image.width, image.height),
      0,
      0,
    );
  }, [image]);
  return ref;
}

/**
 * The comparison stage. Base and Look render as two canvases. In "wipe" mode
 * they stack in one frame and a draggable divider reveals the Look over the
 * Base; in "split" mode they sit side by side. The divider position lives in a
 * ref and drives a CSS variable, so dragging never re-renders React.
 */
export function CompareStage({
  base,
  look,
  lookLabel,
  mode,
  resetKey,
  isLoading,
}: {
  base?: StageImage;
  look?: StageImage;
  lookLabel: string;
  mode: CompareMode;
  resetKey?: string;
  isLoading?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const baseCanvas = useCanvasImage(base);
  const lookCanvas = useCanvasImage(look);
  const wipe = useRef(0.5);
  const dragging = useRef(false);

  const applyWipe = useCallback(() => {
    root.current?.style.setProperty("--wipe", `${wipe.current * 100}%`);
  }, []);

  useEffect(() => {
    wipe.current = 0.5;
    applyWipe();
  }, [resetKey, applyWipe]);

  useEffect(() => {
    applyWipe();
  }, [mode, base, look, applyWipe]);

  const wipeFromEvent = (clientX: number) => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0.5;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (mode !== "wipe" || (!base && !look)) return;
    // Only start a wipe drag from the grip or a band around the divider, so a
    // click elsewhere on the photo doesn't snap the divider to the cursor.
    const onGrip = (event.target as HTMLElement).closest(".compare__grip");
    const rect = root.current?.getBoundingClientRect();
    if (!onGrip && rect) {
      const dividerX = rect.left + wipe.current * rect.width;
      if (Math.abs(event.clientX - dividerX) > 44) return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    wipe.current = wipeFromEvent(event.clientX);
    applyWipe();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    wipe.current = wipeFromEvent(event.clientX);
    applyWipe();
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragging.current = false;
  };

  const onGripKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === "ArrowLeft")
      wipe.current = Math.max(0, wipe.current - step);
    else if (event.key === "ArrowRight")
      wipe.current = Math.min(1, wipe.current + step);
    else return;
    event.preventDefault();
    applyWipe();
  };

  const ready = Boolean(base || look);
  // Size the stage to the photo's aspect and letterbox once around the whole
  // comparison. Split doubles the width so two full frames sit side by side
  // without each pane re-letterboxing the image.
  const dims = base ?? look;
  const aspect = dims ? dims.width / dims.height : 1.5;
  const boxAspect = mode === "split" ? aspect * 2 : aspect;

  return (
    <div
      ref={root}
      className={`compare ${mode === "wipe" ? "is-wipe" : "is-split"} ${
        isLoading ? "is-loading" : ""
      }`}
      style={
        {
          "--wipe": "50%",
          "--ar": String(boxAspect),
        } as React.CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="compare__pane compare__pane--base">
        {base ? (
          <canvas ref={baseCanvas} role="img" aria-label="Base preview" />
        ) : (
          <div className="compare__blank" aria-hidden="true" />
        )}
      </div>
      <div className="compare__pane compare__pane--look">
        {look ? (
          <canvas
            ref={lookCanvas}
            role="img"
            aria-label={`${lookLabel} preview`}
          />
        ) : (
          <div className="compare__blank" aria-hidden="true" />
        )}
      </div>

      {ready && (
        <>
          <span className="compare__tag compare__tag--base">
            <span className="compare__dot" aria-hidden="true" />
            <b>Base</b>
          </span>
          <span className="compare__tag compare__tag--look">
            <span className="compare__dot" aria-hidden="true" />
            <b>{lookLabel}</b>
          </span>
          <div className="compare__divider" aria-hidden="true" />
          <button
            type="button"
            className="compare__grip"
            aria-label="Comparison divider. Drag or use arrow keys to reveal Base and Look."
            onKeyDown={onGripKeyDown}
          >
            <ChevronsLeftRight size={18} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
