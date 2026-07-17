import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

export interface PreviewFocus {
  x: number;
  y: number;
}

export function PreviewCanvas({
  label,
  detail,
  pixels,
  width,
  height,
  viewMode = "fit",
  focus = { x: 0.5, y: 0.5 },
  getFocus,
  onFocusChange,
}: {
  label: string;
  detail: string;
  pixels?: Uint8Array<ArrayBuffer>;
  width?: number;
  height?: number;
  viewMode?: "fit" | "actual";
  focus?: PreviewFocus;
  getFocus?: () => PreviewFocus;
  onFocusChange?: (focus: PreviewFocus) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const imageWell = useRef<HTMLDivElement>(null);
  const [pannable, setPannable] = useState(false);
  const drag = useRef<
    | {
        pointerId: number;
        x: number;
        y: number;
        focus: PreviewFocus;
      }
    | undefined
  >(undefined);

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

  useEffect(() => {
    const update = () => {
      const well = imageWell.current;
      setPannable(
        Boolean(
          viewMode === "actual" &&
            well &&
            width &&
            height &&
            (width > well.clientWidth || height > well.clientHeight),
        ),
      );
    };
    update();
    if (typeof ResizeObserver !== "function" || !imageWell.current) return;
    const observer = new ResizeObserver(update);
    observer.observe(imageWell.current);
    return () => observer.disconnect();
  }, [height, viewMode, width]);

  const constrainFocus = (next: PreviewFocus): PreviewFocus => {
    const well = imageWell.current;
    if (!well || !width || !height) return next;
    const xLimit =
      width <= well.clientWidth ? 0.5 : well.clientWidth / (2 * width);
    const yLimit =
      height <= well.clientHeight ? 0.5 : well.clientHeight / (2 * height);
    return {
      x: Math.max(xLimit, Math.min(1 - xLimit, next.x)),
      y: Math.max(yLimit, Math.min(1 - yLimit, next.y)),
    };
  };

  const publishFocus = (next: PreviewFocus) => {
    onFocusChange?.(constrainFocus(next));
  };

  const moveFocus = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !width || !height || !onFocusChange) return;
    publishFocus({
      x: Math.max(
        0,
        Math.min(
          1,
          drag.current.focus.x - (event.clientX - drag.current.x) / width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          1,
          drag.current.focus.y - (event.clientY - drag.current.y) / height,
        ),
      ),
    });
  };

  const moveFocusWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!width || !height || !onFocusChange) return;
    const current = getFocus?.() ?? focus;
    const step = event.shiftKey ? 96 : 32;
    const next = { ...current };
    if (event.key === "ArrowLeft") next.x -= step / width;
    else if (event.key === "ArrowRight") next.x += step / width;
    else if (event.key === "ArrowUp") next.y -= step / height;
    else if (event.key === "ArrowDown") next.y += step / height;
    else return;
    event.preventDefault();
    publishFocus(next);
  };

  return (
    <figure className="pane">
      <figcaption className="pane-caption">
        <strong>{label}</strong>
        <span>{detail}</span>
      </figcaption>
      <div
        ref={imageWell}
        className={`pane-well is-${viewMode} ${pannable ? "can-pan" : ""}`}
        tabIndex={viewMode === "actual" && pannable ? 0 : undefined}
        role={viewMode === "actual" && pannable ? "group" : undefined}
        aria-label={
          viewMode === "actual" && pannable
            ? `${label} preview inspection. Drag or use arrow keys to pan.`
            : undefined
        }
        onPointerDown={(event) => {
          if (viewMode !== "actual" || !pixels || !pannable) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            focus: getFocus?.() ?? focus,
          };
        }}
        onPointerMove={moveFocus}
        onKeyDown={moveFocusWithKeyboard}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = undefined;
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
      >
        {pixels ? (
          <canvas
            ref={canvas}
            role="img"
            aria-label={`${label} preview`}
            style={
              viewMode === "actual" && width && height
                ? {
                    width,
                    height,
                    left: `calc(50% + ${(0.5 - focus.x) * width}px)`,
                    top: `calc(50% + ${(0.5 - focus.y) * height}px)`,
                  }
                : undefined
            }
          />
        ) : (
          <div className="pane-placeholder" aria-hidden="true" />
        )}
      </div>
    </figure>
  );
}
