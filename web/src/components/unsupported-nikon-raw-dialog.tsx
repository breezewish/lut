import { ExternalLink, TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "./ui/button";

const ADOBE_DNG_CONVERTER_URL =
  "https://helpx.adobe.com/camera-raw/digital-negative.html";

export function UnsupportedNikonRawDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

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
          <h2 id="raw-format-dialog-title">
            Nikon High Efficiency RAW is not supported
          </h2>
          <p
            id="raw-format-dialog-reason"
            className="raw-format-dialog__reason"
          >
            <strong>Why:</strong> This NEF uses TicoRAW. Its decoder requires a
            commercial license.
          </p>
        </div>
      </div>

      <ol className="raw-format-dialog__solutions">
        <li>
          <span className="raw-format-dialog__step" aria-hidden="true">
            1
          </span>
          <div>
            <h3>For this photo</h3>
            <p>
              Convert the NEF to DNG with Adobe Lightroom / Photoshop / Adobe
              DNG Converter (free), then reopen it in LUTify.
            </p>
          </div>
        </li>
        <li>
          <span className="raw-format-dialog__step" aria-hidden="true">
            2
          </span>
          <div>
            <h3>For future photos</h3>
            <p>
              On your Nikon camera, set <strong>Photo Shooting Menu</strong>
              {" → "}
              <strong>RAW Recording</strong>
              {" → "}
              <strong>RAW Compression</strong>
              {" to "}
              <strong>Lossless Compression</strong>.
            </p>
          </div>
        </li>
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
