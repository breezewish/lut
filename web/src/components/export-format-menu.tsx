import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { OUTPUT_FORMATS } from "../lib/output-formats";
import type { OutputFormat } from "../types";
import { Button } from "./ui/button";

const FORMAT_IDS: OutputFormat[] = ["tiff", "jpeg"];

export function ExportFormatMenu({
  value,
  disabled,
  onChange,
}: {
  value: OutputFormat;
  disabled: boolean;
  onChange: (format: OutputFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selectedOption = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    const closeOutside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) selectedOption.current?.focus();
  }, [open]);

  const focusTrigger = () =>
    root.current
      ?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
      ?.focus();

  return (
    <div
      ref={root}
      className="export-format-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          focusTrigger();
        }
      }}
    >
      <Button
        className="export-format-menu__trigger"
        size="icon"
        variant="primary"
        aria-label={`Choose export format, current ${OUTPUT_FORMATS[value].label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={15} aria-hidden="true" />
      </Button>
      {open && (
        <div
          id={menuId}
          className="export-format-menu__popup"
          role="menu"
          aria-label="Export format"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"]',
              ),
            );
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : event.key === "ArrowDown"
                    ? (current + 1) % items.length
                    : (current - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {FORMAT_IDS.map((format) => (
            <button
              key={format}
              ref={format === value ? selectedOption : undefined}
              type="button"
              role="menuitemradio"
              aria-checked={format === value}
              aria-label={OUTPUT_FORMATS[format].optionLabel}
              onClick={() => {
                onChange(format);
                setOpen(false);
                focusTrigger();
              }}
            >
              <span>{OUTPUT_FORMATS[format].optionLabel}</span>
              {format === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
