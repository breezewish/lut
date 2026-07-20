import { Zip, ZipPassThrough } from "fflate";
import { useRef, useState } from "react";

import type { LutManifest, OutputFormat, QueueItem } from "../types";
import { describeProcessingError } from "./errors";
import { OUTPUT_FORMATS } from "./output-formats";
import type { ProcessingClient } from "./processing-client";

export interface ExportProgress {
  current: number;
  total: number;
  fileName: string;
  stopRequested?: boolean;
}

/** Owns serial browser export, ZIP assembly, progress, and download state. */
export function useExportQueue({
  targets,
  manifest,
  activeSettled,
  client,
  updateItem,
  onError,
}: {
  targets: QueueItem[];
  manifest: LutManifest | undefined;
  activeSettled: boolean;
  client: ProcessingClient;
  updateItem: (id: string, patch: Partial<QueueItem>) => void;
  onError: (message: string | undefined) => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>();
  const [summary, setSummary] = useState<string>();
  const [format, setFormat] = useState<OutputFormat>("tiff");
  const stopAfterCurrent = useRef(false);
  const canExport = Boolean(
    !exporting && manifest && targets.length > 0 && activeSettled,
  );

  const start = async () => {
    if (!manifest || exporting || targets.length === 0) return;
    const single = targets.length === 1;
    const output = OUTPUT_FORMATS[format];
    setExporting(true);
    onError(undefined);
    setSummary(undefined);
    stopAfterCurrent.current = false;
    const outputNames = new Set<string>();
    const archiveChunks: Uint8Array<ArrayBuffer>[] = [];
    let archiveError: Error | undefined;
    const archive = single
      ? undefined
      : new Zip((zipError, chunk) => {
          if (zipError) archiveError = zipError;
          else if (chunk) {
            if (!(chunk.buffer instanceof ArrayBuffer)) {
              archiveError = new Error(
                "The ZIP encoder returned unsupported shared memory.",
              );
            } else {
              archiveChunks.push(
                new Uint8Array(
                  chunk.buffer,
                  chunk.byteOffset,
                  chunk.byteLength,
                ),
              );
            }
          }
        });
    let singleOutput:
      | { name: string; bytes: Uint8Array<ArrayBuffer> }
      | undefined;
    const failed: string[] = [];
    let stopped = false;
    let lutId = "look";

    try {
      for (const [index, item] of targets.entries()) {
        const lut = manifest.luts.find(({ id }) => id === item.lutId);
        if (!lut) {
          failed.push(item.file.name);
          continue;
        }
        lutId = lut.id;
        setProgress({
          current: index + 1,
          total: targets.length,
          fileName: item.file.name,
        });
        updateItem(item.id, { status: "exporting", error: undefined });
        let image: Uint8Array | undefined;
        try {
          const exported = await client.export({
            fileId: item.id,
            file: item.file,
            ev: item.ev,
            whiteBalance: {
              temperature: item.temperature,
              tint: item.tint,
            },
            baseEv: item.baseEv,
            lut,
            format,
          });
          image = exported.bytes;
          if (item.baseEv === undefined) {
            updateItem(item.id, { baseEv: exported.baseEv });
          }
          performance.mark("lutify:export-worker", {
            detail: {
              ...exported.timings,
              baseEv: exported.baseEv,
              userEv: item.ev,
              effectiveEv: exported.baseEv + item.ev,
              temperature: item.temperature,
              tint: item.tint,
            },
          });
        } catch (exportError) {
          const message = describeProcessingError(exportError);
          failed.push(item.file.name);
          updateItem(item.id, { status: "export-error", error: message });
          onError(message);
        }

        if (image) {
          if (!(image.buffer instanceof ArrayBuffer)) {
            throw new Error(
              "The image encoder returned unsupported shared memory.",
            );
          }
          const outputBytes = new Uint8Array(
            image.buffer,
            image.byteOffset,
            image.byteLength,
          );
          const base = item.file.name.replace(/\.[^.]+$/, "") || "image";
          const stem = `${base}-${lut.id}`;
          let outputName = `${stem}.${output.extension}`;
          let suffix = 2;
          while (outputNames.has(outputName)) {
            outputName = `${stem}-${suffix}.${output.extension}`;
            suffix += 1;
          }
          outputNames.add(outputName);
          if (archive) {
            const entry = new ZipPassThrough(outputName);
            archive.add(entry);
            entry.push(outputBytes, true);
            if (archiveError) throw archiveError;
          } else {
            singleOutput = { name: outputName, bytes: outputBytes };
          }
          updateItem(item.id, { status: "done" });
        }

        if (stopAfterCurrent.current && index + 1 < targets.length) {
          stopped = true;
          break;
        }
      }

      archive?.end();
      if (archiveError) throw archiveError;
      if (outputNames.size > 0) {
        const blob = new Blob(
          singleOutput ? [singleOutput.bytes] : archiveChunks,
          {
            type: single ? output.mime : "application/zip",
          },
        );
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = single ? singleOutput!.name : `lutify-${lutId}.zip`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }

      const detail = failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : "";
      setSummary(
        stopped
          ? `Stopped after ${outputNames.size} of ${targets.length} ${output.label} exports.${detail}`
          : `Exported ${outputNames.size} of ${targets.length} as ${output.label}.${detail}`,
      );
    } catch (exportError) {
      onError(describeProcessingError(exportError));
    } finally {
      setProgress(undefined);
      setExporting(false);
    }
  };

  return {
    exporting,
    progress,
    summary,
    clearSummary: () => setSummary(undefined),
    format,
    setFormat,
    canExport,
    start,
    requestStop: () => {
      stopAfterCurrent.current = true;
      setProgress((current) =>
        current ? { ...current, stopRequested: true } : current,
      );
    },
  };
}
