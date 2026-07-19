import { memo, useEffect, useId, useRef } from "react";
import { Check, Search } from "lucide-react";

import type { LutDefinition } from "../types";

export interface LookThumbImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/** Composites one Worker-created look thumbnail without main-thread pixels. */
function LookThumb({ image, alt }: { image: LookThumbImage; alt: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    // Assigning either dimension destroys the backing store even when the
    // value is unchanged. Avoid rebuilding every LUT canvas in one commit
    // when a warm photo cache is restored.
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    context.drawImage(image.bitmap, 0, 0);
  }, [image]);
  return <canvas ref={ref} role="img" aria-label={alt} />;
}

/**
 * The Looks panel — a searchable grid of built-in looks where each tile renders
 * the current photo under that look, so a photographer chooses by seeing the
 * result. Selecting a tile applies the look to every selected photo.
 */
export const LookPanel = memo(function LookPanel({
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
  thumbs: Map<string, LookThumbImage>;
  query: string;
  onQuery: (value: string) => void;
  disabled?: boolean;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const groupLabelId = useId();
  // Keep the selected look scrolled into view (e.g. after switching photos)
  // without ever reordering the grid.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const normalized = query.trim().toLocaleLowerCase();
  const visible = looks.filter(
    (lut) =>
      normalized.length === 0 ||
      `${lut.group} ${lut.name}`.toLocaleLowerCase().includes(normalized),
  );
  const groups = new Map<string, LutDefinition[]>();
  for (const lut of visible) {
    const group = groups.get(lut.group);
    if (group) group.push(lut);
    else groups.set(lut.group, [lut]);
  }

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
      <div className="looks__catalog" role="group" aria-label="Built-in looks">
        {visible.length === 0 ? (
          <p className="looks__empty" role="status">
            No looks match “{query}”.
          </p>
        ) : (
          [...groups].map(([group, groupedLooks], groupIndex) => {
            const headingId = `${groupLabelId}-${groupIndex}`;
            return (
              <div
                key={group}
                className="look-group"
                role="group"
                aria-labelledby={headingId}
              >
                <h3 id={headingId} className="look-group__title">
                  {group}
                </h3>
                <div className="looks__grid">
                  {groupedLooks.map((lut) => {
                    const image = thumbs.get(lut.id);
                    const active = lut.id === activeId;
                    return (
                      <button
                        key={lut.id}
                        ref={active ? activeRef : undefined}
                        type="button"
                        aria-label={lut.name}
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
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
});
