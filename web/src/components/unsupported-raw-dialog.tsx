import { ExternalLink, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import type { UnsupportedRawFormat } from "../lib/errors";
import { Button } from "./ui/button";

const ADOBE_DNG_CONVERTER_URL =
  "https://helpx.adobe.com/camera-raw/digital-negative.html";

interface DialogContent {
  title: string;
  reason: ReactNode;
  solutions: ReadonlyArray<{ title: string; text: ReactNode }>;
}

const CONTENT: Record<UnsupportedRawFormat, DialogContent> = {
  "nikon-high-efficiency": {
    title: "Nikon High Efficiency RAW is not supported",
    reason: (
      <>This NEF uses TicoRAW. Its decoder requires a commercial license.</>
    ),
    solutions: [
      {
        title: "For this photo",
        text: (
          <>
            Convert it to DNG with Adobe Lightroom / Photoshop / Adobe DNG
            Converter (free), then reopen it in LUTify.
          </>
        ),
      },
      {
        title: "For future photos",
        text: (
          <>
            On your Nikon camera, set <strong>RAW Compression</strong> to{" "}
            <strong>Lossless Compression</strong>.
          </>
        ),
      },
    ],
  },
  "gopro-gpr": {
    title: "GoPro GPR is not supported",
    reason: <>This GPR uses VC-5 compression, which LUTify cannot decode.</>,
    solutions: [
      {
        title: "Use this photo",
        text: (
          <>
            Convert it to a standard DNG with Adobe Lightroom / Photoshop /
            Adobe DNG Converter (free), then reopen it in LUTify.
          </>
        ),
      },
    ],
  },
  "jpeg-xl-dng": {
    title: "JPEG XL–compressed DNG is not supported",
    reason: <>This DNG stores its RAW image with JPEG XL compression.</>,
    solutions: [
      {
        title: "For this photo",
        text: (
          <>
            Re-save it as a compatible DNG with Adobe Lightroom / Photoshop /
            Adobe DNG Converter (free), then reopen it in LUTify.
          </>
        ),
      },
      {
        title: "For future iPhone photos",
        text: (
          <>
            Set <strong>ProRAW Format</strong> to{" "}
            <strong>JPEG Lossless (Most Compatible)</strong>.
          </>
        ),
      },
    ],
  },
};

export function UnsupportedRawDialog({
  format,
  onClose,
}: {
  format: UnsupportedRawFormat;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const content = CONTENT[format];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="raw-format-dialog"
      aria-labelledby="raw-format-dialog-title"
      aria-describedby="raw-format-dialog-reason"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="raw-format-dialog__heading">
        <span className="raw-format-dialog__icon" aria-hidden="true">
          <TriangleAlert size={20} />
        </span>
        <div>
          <h2 id="raw-format-dialog-title">{content.title}</h2>
          <p id="raw-format-dialog-reason">
            <strong>Why:</strong> {content.reason}
          </p>
        </div>
      </div>

      <ol className="raw-format-dialog__solutions">
        {content.solutions.map((solution, index) => (
          <li key={solution.title}>
            <span className="raw-format-dialog__step" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <h3>{solution.title}</h3>
              <p>{solution.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="raw-format-dialog__actions">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <a
          className="btn"
          data-size="default"
          data-variant="primary"
          href={ADOBE_DNG_CONVERTER_URL}
          target="_blank"
          rel="noreferrer"
        >
          Get Adobe DNG Converter
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    </dialog>
  );
}
