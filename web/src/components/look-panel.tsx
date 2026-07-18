import { useEffect, useRef } from "react";
import { Check, Search } from "lucide-react";

import type { StageImage } from "./compare-stage";
import type { LutDefinition } from "../types";
/** Draws a look thumbnail buffer into its canvas without a second full copy. */
function LookThumb({ image, alt }: { image: StageImage; alt: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
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
  return <canvas ref={ref} role="img" aria-label={alt} />;
}

/**
 * The Looks panel — a searchable grid of built-in looks where each tile renders
 * the current photo under that look, so a photographer chooses by seeing the
 * result. Selecting a tile applies the look to every selected photo.
 */
export function LookPanel({
  looks,
  activeId,
  onChoose,
  thumbs,
  query,
  onQuery,
  disabled = false,
}: {
  looks: LutDefinition[];
  activeId: string;
  onChoose: (id: string) => void;
  thumbs: Map<string, StageImage>;
  query: string;
  onQuery: (value: string) => void;
  disabled?: boolean;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  // Keep the selected look scrolled into view (e.g. after switching photos)
  // without ever reordering the grid.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const normalized = query.trim().toLocaleLowerCase();
  const visible = looks.filter(
    (lut) =>
      lut.id === activeId ||
      normalized.length === 0 ||
      `${lut.group} ${lut.name}`.toLocaleLowerCase().includes(normalized),
  );

  return (
    <>
      <label className="looks__search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          aria-label="Look"
          value={query}
          disabled={disabled}
          placeholder="Search looks…"
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <div className="looks__grid" role="group" aria-label="Built-in looks">
        {visible.length === 0 ? (
          <p className="looks__empty" role="status">
            No looks match “{query}”.
          </p>
        ) : (
          visible.map((lut) => {
            const image = thumbs.get(lut.id);
            const active = lut.id === activeId;
            return (
              <button
                key={lut.id}
                ref={active ? activeRef : undefined}
                type="button"
                aria-pressed={active}
                className={`look ${active ? "is-active" : ""} ${image ? "" : "is-loading"}`}
                title={`${lut.group} · ${lut.name}`}
                disabled={disabled}
                onClick={() => onChoose(lut.id)}
              >
                <span className="look__thumb">
                  {image && (
                    <LookThumb image={image} alt={`${lut.name} look`} />
                  )}
                  <span className="look__check" aria-hidden="true">
                    <Check size={12} />
                  </span>
                </span>
                <span className="look__name">{lut.name}</span>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
