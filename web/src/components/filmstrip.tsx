import {
  Circle,
  CircleAlert,
  CircleCheck,
  FileImage,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CSSProperties } from "react";
import { memo } from "react";

import type { QueueItem } from "../types";

function StatusGlyph({ status }: { status: QueueItem["status"] }) {
  switch (status) {
    case "decoding":
    case "exporting":
      return <LoaderCircle size={12} aria-hidden="true" />;
    case "done":
      return <CircleCheck size={12} aria-hidden="true" />;
    case "decode-error":
    case "export-error":
      return <CircleAlert size={12} aria-hidden="true" />;
    default:
      return <Circle size={12} aria-hidden="true" />;
  }
}

const STATUS_LABELS: Record<QueueItem["status"], string> = {
  queued: "Queued",
  decoding: "Decoding",
  ready: "Ready",
  exporting: "Exporting",
  done: "Exported",
  "decode-error": "Failed",
  "export-error": "Failed",
};

export interface PhotoSelect {
  additive: boolean;
  range: boolean;
}

/**
 * The bottom photo filmstrip. Every imported RAW is a tile; clicking activates
 * it (Cmd/Ctrl-click adds to a multi-selection, Shift-click extends a range).
 * Each edit follows its photo. Arrow-key navigation is handled by the app shell.
 */
export const Filmstrip = memo(function Filmstrip({
  items,
  activeId,
  selectedIds,
  exporting,
  onSelect,
  onRemove,
  onAdd,
}: {
  items: QueueItem[];
  activeId?: string;
  selectedIds: Set<string>;
  exporting: boolean;
  onSelect: (id: string, modifiers: PhotoSelect) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  const selectionOrder = [...selectedIds];
  const multi = selectedIds.size > 1;

  return (
    <div className="filmstrip" aria-label="Photo filmstrip">
      {items.length === 0 ? (
        <button
          type="button"
          className="filmstrip__drop"
          disabled={exporting}
          onClick={onAdd}
        >
          <Plus size={16} aria-hidden="true" />
          Drop RAW files here or choose from device
        </button>
      ) : (
        <ul className="filmstrip__scroll" aria-label="Photos">
          {items.map((item) => {
            const selected = selectedIds.has(item.id);
            const active = item.id === activeId;
            return (
              <li
                key={item.id}
                className="photo-wrap"
                data-orientation={
                  item.thumbnailAspect !== undefined && item.thumbnailAspect < 1
                    ? "portrait"
                    : undefined
                }
                style={
                  item.thumbnailAspect === undefined
                    ? undefined
                    : ({
                        "--preview-aspect": item.thumbnailAspect,
                      } as CSSProperties)
                }
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-current={active ? "true" : undefined}
                  aria-label={`${item.file.name} — ${STATUS_LABELS[item.status]}`}
                  className={`photo status-${item.status} ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
                  disabled={exporting}
                  onPointerDown={(event: ReactPointerEvent) => {
                    if (event.button !== 0) return;
                    onSelect(item.id, {
                      additive: event.metaKey || event.ctrlKey,
                      range: event.shiftKey,
                    });
                  }}
                >
                  {item.thumbUrl ? (
                    <img
                      className="photo__thumb"
                      src={item.thumbUrl}
                      alt=""
                      draggable={false}
                    />
                  ) : (
                    <span className="photo__fallback" aria-hidden="true">
                      <FileImage size={20} />
                    </span>
                  )}
                  {multi && selected && (
                    <span className="photo__badge" aria-hidden="true">
                      {selectionOrder.indexOf(item.id) + 1}
                    </span>
                  )}
                  <span className="photo__meta">
                    <span className="photo__status" aria-hidden="true">
                      <StatusGlyph status={item.status} />
                    </span>
                    <span className="photo__name">{item.file.name}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="photo__remove"
                  aria-label={`Remove ${item.file.name}`}
                  disabled={exporting}
                  onClick={() => onRemove(item.id)}
                >
                  <X size={13} />
                </button>
              </li>
            );
          })}
          <li className="photo-wrap photo-wrap--add">
            <button
              type="button"
              className="photo photo--add"
              aria-label="Add RAW files"
              disabled={exporting}
              onClick={onAdd}
            >
              <Plus size={20} aria-hidden="true" />
            </button>
          </li>
        </ul>
      )}
    </div>
  );
});
