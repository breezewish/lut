import {
  CircleStop,
  FileImage,
  FolderOpen,
  ImageDown,
  LockKeyhole,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Zip, ZipPassThrough } from "fflate";

import { PreviewCanvas } from "./components/preview-canvas";
import { Button } from "./components/ui/button";
import { Select } from "./components/ui/select";
import { ProcessingClient } from "./lib/processing-client";
import type { LutManifest, PreviewResult, QueueItem } from "./types";

const RAW_ACCEPT =
  ".3fr,.ari,.arw,.bay,.cap,.cr2,.cr3,.dcr,.dcs,.dng,.drf,.eip,.erf,.fff,.gpr,.iiq,.k25,.kdc,.mdc,.mef,.mos,.mrw,.nef,.nrw,.orf,.pef,.ptx,.pxn,.r3d,.raf,.raw,.rwl,.rw2,.rwz,.sr2,.srf,.srw,.x3f";

const STATUS_LABELS: Record<QueueItem["status"], string> = {
  queued: "Queued",
  decoding: "Decoding",
  ready: "Ready",
  exporting: "Exporting",
  done: "Exported",
  error: "Failed",
};

interface ExportProgress {
  current: number;
  total: number;
  fileName: string;
  stopRequested?: boolean;
}

interface QueueUndo {
  items: QueueItem[];
  selectedId?: string;
  message: string;
}

export default function App() {
  const [client] = useState(() => new ProcessingClient());
  const [manifest, setManifest] = useState<LutManifest>();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [lutId, setLutId] = useState("fuji-classic-negative");
  const [ev, setEv] = useState(0);
  const [preview, setPreview] = useState<PreviewResult>();
  const [cameraPreview, setCameraPreview] = useState<{
    fileId: string;
    url: string;
  }>();
  const [globalError, setGlobalError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress>();
  const [exportSummary, setExportSummary] = useState<string>();
  const [queueUndo, setQueueUndo] = useState<QueueUndo>();
  const [lookQuery, setLookQuery] = useState("");
  const [recentLutIds, setRecentLutIds] = useState<string[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("raw-alchemy-recent-luts") ?? "[]",
      ) as string[];
    } catch {
      return [];
    }
  });
  const decodedFileId = useRef<string | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const exposureInput = useRef<HTMLInputElement>(null);
  const stopAfterCurrent = useRef(false);

  const selected = items.find((item) => item.id === selectedId);
  const selectedLut = manifest?.luts.find((lut) => lut.id === lutId);
  const exportableItems = items.filter((item) => item.status !== "error");

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/luts/manifest.json")
      .then((response) => {
        if (!response.ok)
          throw new Error("The built-in LUT manifest could not be loaded.");
        return response.json() as Promise<LutManifest>;
      })
      .then((value) => {
        if (active) setManifest(value);
      })
      .catch((error: Error) => {
        if (active) setGlobalError(error.message);
      });
    return () => {
      active = false;
      client.dispose();
    };
  }, [client]);

  useEffect(() => {
    const unsubscribe = client.onThumbnail(({ fileId, jpeg }) => {
      const url = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
      setCameraPreview({ fileId, url });
    });
    return unsubscribe;
  }, [client]);

  useEffect(
    () => () => {
      if (cameraPreview) URL.revokeObjectURL(cameraPreview.url);
    },
    [cameraPreview],
  );

  useEffect(() => {
    if (!selected || !selectedLut) return;
    let active = true;
    decodedFileId.current = undefined;
    setPreview(undefined);
    setCameraPreview(undefined);
    setGlobalError(undefined);
    updateItem(selected.id, { status: "decoding", error: undefined });

    selected.file
      .arrayBuffer()
      .then((buffer) => client.decode(selected.id, buffer, ev, selectedLut))
      .then((result) => {
        if (!active) return;
        decodedFileId.current = selected.id;
        setPreview(result);
        setCameraPreview(undefined);
        updateItem(selected.id, {
          status: "ready",
          camera: result.metadata.camera || "Unknown camera",
          dimensions: `${result.metadata.width} × ${result.metadata.height}`,
        });
      })
      .catch((error: Error) => {
        if (!active) return;
        updateItem(selected.id, { status: "error", error: error.message });
        setGlobalError(error.message);
      });

    return () => {
      active = false;
    };
  }, [client, selected?.id, Boolean(selectedLut), updateItem]);

  useEffect(() => {
    if (
      !selected ||
      !selectedLut ||
      !["ready", "done"].includes(selected.status) ||
      decodedFileId.current !== selected.id
    )
      return;
    let active = true;
    const timer = window.setTimeout(() => {
      client
        .render(selected.id, ev, selectedLut)
        .then((result) => {
          if (active) setPreview(result);
        })
        .catch((error: Error) => {
          if (active) setGlobalError(error.message);
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [client, ev, selected?.id, selected?.status, selectedLut?.id]);

  useEffect(() => {
    if (
      exposureInput.current &&
      document.activeElement !== exposureInput.current
    ) {
      exposureInput.current.value = String(ev);
    }
  }, [ev]);

  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setGlobalError(undefined);
    setQueueUndo(undefined);
    setExportSummary(undefined);
    const first = files[0];
    setSelectedId(
      (current) =>
        current ?? `${first.name}:${first.size}:${first.lastModified}`,
    );
    setItems((current) => {
      const existing = new Set(current.map((item) => item.id));
      const additions: QueueItem[] = [];
      for (const file of files) {
        const id = `${file.name}:${file.size}:${file.lastModified}`;
        if (existing.has(id)) continue;
        existing.add(id);
        additions.push({ id, file, status: "queued" });
      }
      return [...current, ...additions];
    });
  }, []);

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (exporting) return;
    addFiles(Array.from(event.dataTransfer.files));
  };

  const removeItem = (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    setQueueUndo({
      items: [item],
      selectedId: selectedId === id ? id : undefined,
      message: `Removed ${item.file.name}`,
    });
    setItems((current) => current.filter((item) => item.id !== id));
    if (selectedId === id) {
      const next = items.find((item) => item.id !== id);
      setSelectedId(next?.id);
      setPreview(undefined);
      decodedFileId.current = undefined;
    }
  };

  const clearQueue = () => {
    setQueueUndo({
      items,
      selectedId,
      message: `Cleared ${items.length} file${items.length === 1 ? "" : "s"}`,
    });
    setItems([]);
    setSelectedId(undefined);
    setPreview(undefined);
    setExportSummary(undefined);
    decodedFileId.current = undefined;
  };

  const restoreQueue = () => {
    if (!queueUndo) return;
    setItems((current) => {
      const currentIds = new Set(current.map((item) => item.id));
      return [
        ...queueUndo.items.filter((item) => !currentIds.has(item.id)),
        ...current,
      ];
    });
    if (queueUndo.selectedId) setSelectedId(queueUndo.selectedId);
    setQueueUndo(undefined);
  };

  const exportItems = async (targets: QueueItem[]) => {
    const eligibleTargets = targets.filter((item) => item.status !== "error");
    if (!selectedLut || eligibleTargets.length === 0) return;
    setExporting(true);
    setGlobalError(undefined);
    setExportSummary(undefined);
    stopAfterCurrent.current = false;
    const single = targets.length === 1;
    const outputNames = new Set<string>();
    // TIFF payloads are already Deflate-compressed. Pass-through ZIP entries
    // avoid redundant compression and a second contiguous archive buffer.
    const archiveChunks: Uint8Array<ArrayBuffer>[] = [];
    let archiveError: Error | undefined;
    const archive = single
      ? undefined
      : new Zip((error, chunk) => {
          if (error) archiveError = error;
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

    try {
      for (const [index, item] of eligibleTargets.entries()) {
        setExportProgress({
          current: index + 1,
          total: eligibleTargets.length,
          fileName: item.file.name,
        });
        updateItem(item.id, { status: "exporting", error: undefined });
        let tiff: Uint8Array | undefined;
        try {
          tiff = await client.export(
            item.id,
            await item.file.arrayBuffer(),
            ev,
            selectedLut,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failed.push(item.file.name);
          updateItem(item.id, { status: "error", error: message });
        }

        if (tiff) {
          if (!(tiff.buffer instanceof ArrayBuffer)) {
            throw new Error(
              "The TIFF encoder returned unsupported shared memory.",
            );
          }
          const outputBytes = new Uint8Array(
            tiff.buffer,
            tiff.byteOffset,
            tiff.byteLength,
          );
          const base = item.file.name.replace(/\.[^.]+$/, "") || "image";
          const stem = `${base}-${selectedLut.id}`;
          let outputName = `${stem}.tif`;
          let suffix = 2;
          while (outputNames.has(outputName)) {
            outputName = `${stem}-${suffix}.tif`;
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

        if (stopAfterCurrent.current && index + 1 < eligibleTargets.length) {
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
            type: single ? "image/tiff" : "application/zip",
          },
        );
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = single
          ? singleOutput!.name
          : `raw-alchemy-${selectedLut.id}.zip`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }

      const skippedBeforeStart = targets.length - eligibleTargets.length;
      const skipped = failed.length + skippedBeforeStart;
      const detail = failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : "";
      setExportSummary(
        stopped
          ? `Stopped after ${outputNames.size} of ${eligibleTargets.length} exports.${detail}`
          : `Exported ${outputNames.size} of ${eligibleTargets.length}.${skipped > 0 ? ` Skipped ${skipped}.` : ""}${detail}`,
      );
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportProgress(undefined);
      setExporting(false);
    }
  };

  const selectOptions = useMemo(() => {
    const luts = manifest?.luts ?? [];
    const query = lookQuery.trim().toLocaleLowerCase();
    const matches = luts.filter(
      (lut) =>
        lut.id === lutId ||
        query.length === 0 ||
        `${lut.group} ${lut.name}`.toLocaleLowerCase().includes(query),
    );
    const recent = query
      ? []
      : recentLutIds
          .map((id) => matches.find((lut) => lut.id === id))
          .filter((lut) => lut !== undefined);
    const recentIds = new Set(recent.map((lut) => lut.id));
    return [
      ...recent.map((lut) => ({
        value: lut.id,
        label: lut.name,
        group: "Recent",
      })),
      ...matches
        .filter((lut) => !recentIds.has(lut.id))
        .map((lut) => ({
          value: lut.id,
          label: lut.name,
          group: lut.group,
        })),
    ];
  }, [lookQuery, lutId, manifest, recentLutIds]);

  const chooseLut = (value: string) => {
    setLutId(value);
    setLookQuery("");
    const next = [
      value,
      ...recentLutIds.filter((candidate) => candidate !== value),
    ].slice(0, 4);
    setRecentLutIds(next);
    try {
      localStorage.setItem("raw-alchemy-recent-luts", JSON.stringify(next));
    } catch {
      // Browsers may disable storage; recent looks are a non-essential aid.
    }
  };

  const statusText =
    items.length === 0
      ? "No files"
      : `${items.length} local file${items.length === 1 ? "" : "s"}`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            RA
          </div>
          <div>
            <h1>RAW Alchemy</h1>
            <p>Private color lab</p>
          </div>
        </div>
        <div className="privacy-note">
          <LockKeyhole size={16} aria-hidden="true" />
          <span>Files stay on this device</span>
        </div>
        <div className="topbar-actions">
          <span className="file-count">{statusText}</span>
          <Button
            variant="secondary"
            aria-label="Add RAW files"
            disabled={exporting}
            onClick={() => fileInput.current?.click()}
          >
            <Plus size={17} aria-hidden="true" />
            <span className="add-raw-label">Add RAWs</span>
          </Button>
          {items.length > 1 && (
            <Button
              onClick={() => void exportItems(items)}
              disabled={
                exportableItems.length === 0 || exporting || !selectedLut
              }
            >
              <ImageDown size={17} aria-hidden="true" />
              {exporting ? "Exporting…" : "Export all"}
            </Button>
          )}
        </div>
      </header>

      <div className="app-grid">
        <aside
          className="queue-panel"
          aria-label="RAW queue"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <div className="queue-heading">
            <div className="queue-heading-copy">
              <h2>Queue</h2>
              <p>Full-resolution export runs one at a time.</p>
            </div>
            {items.length > 0 && (
              <Button
                size="icon"
                variant="quiet"
                aria-label="Clear queue"
                disabled={exporting}
                onClick={clearQueue}
              >
                <Trash2 size={17} />
              </Button>
            )}
          </div>

          {items.length === 0 ? (
            <button
              type="button"
              className="drop-zone"
              onClick={() => fileInput.current?.click()}
            >
              <FolderOpen size={24} aria-hidden="true" />
              <strong>0 local files</strong>
              <span>Drop camera RAW files here.</span>
            </button>
          ) : (
            <div className="queue-list">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={`queue-item ${item.id === selectedId ? "is-selected" : ""}`}
                >
                  <button
                    className="queue-select"
                    aria-current={item.id === selectedId ? "true" : undefined}
                    disabled={exporting}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <FileImage size={18} aria-hidden="true" />
                    <span className="queue-copy">
                      <strong>{item.file.name}</strong>
                      <span>
                        {item.status === "error"
                          ? "Could not decode"
                          : item.camera ||
                            `${(item.file.size / 1_048_576).toFixed(1)} MB`}
                      </span>
                    </span>
                    <span className="queue-status">
                      <span
                        className={`status-dot status-${item.status}`}
                        aria-hidden="true"
                      />
                      {STATUS_LABELS[item.status]}
                    </span>
                  </button>
                  <button
                    className="remove-file"
                    aria-label={`Remove ${item.file.name}`}
                    disabled={exporting}
                    onClick={() => removeItem(item.id)}
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept={RAW_ACCEPT}
            multiple
            disabled={exporting}
            onChange={onFileInput}
          />
        </aside>

        <main className="workspace">
          {selected && (
            <section className="control-bar" aria-label="Processing controls">
              <div className="control-group lut-control">
                <label htmlFor="look-search">Look</label>
                <div className="look-picker">
                  <input
                    id="look-search"
                    type="search"
                    value={lookQuery}
                    disabled={exporting}
                    placeholder={`Search ${manifest?.luts.length ?? 27} looks`}
                    onChange={(event) => setLookQuery(event.target.value)}
                  />
                  <Select
                    label="Built-in V-Log look"
                    value={lutId}
                    onValueChange={chooseLut}
                    options={selectOptions}
                    disabled={exporting}
                  />
                </div>
                <p className="lut-assumption">
                  Output profile is undeclared; preview assumes sRGB.
                </p>
              </div>
              <div className="exposure-actions">
                <div className="control-group exposure-control">
                  <div className="control-label-row">
                    <label htmlFor="exposure">Exposure</label>
                    <label className="ev-value">
                      <input
                        ref={exposureInput}
                        aria-label="Exposure value"
                        type="number"
                        min="-4"
                        max="4"
                        step="0.1"
                        defaultValue={ev}
                        disabled={exporting}
                        onChange={(event) => {
                          const value = event.currentTarget.valueAsNumber;
                          if (Number.isFinite(value)) {
                            setEv(Math.max(-4, Math.min(4, value)));
                          }
                        }}
                        onBlur={(event) => {
                          event.currentTarget.value = String(ev);
                        }}
                      />
                      <span>EV</span>
                    </label>
                  </div>
                  <input
                    id="exposure"
                    type="range"
                    min="-4"
                    max="4"
                    step="0.1"
                    value={ev}
                    disabled={exporting}
                    onChange={(event) => setEv(Number(event.target.value))}
                  />
                </div>
                <Button
                  variant="quiet"
                  onClick={() => setEv(0)}
                  disabled={exporting || ev === 0}
                >
                  <RotateCcw size={16} aria-hidden="true" /> Reset
                </Button>
              </div>
            </section>
          )}

          {globalError && (
            <div className="error-banner" role="alert">
              <span>{globalError}</span>
              <div className="banner-actions">
                {selected?.status === "error" && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => removeItem(selected.id)}
                    >
                      Remove file
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => fileInput.current?.click()}
                    >
                      Choose another RAW
                    </Button>
                  </>
                )}
                <Button
                  size="icon"
                  variant="quiet"
                  aria-label="Dismiss error"
                  onClick={() => setGlobalError(undefined)}
                >
                  <X size={17} />
                </Button>
              </div>
            </div>
          )}

          {queueUndo && (
            <div className="undo-banner" role="status">
              <span>{queueUndo.message}</span>
              <div className="banner-actions">
                <Button variant="secondary" onClick={restoreQueue}>
                  Undo
                </Button>
                <Button
                  size="icon"
                  variant="quiet"
                  aria-label="Dismiss undo"
                  onClick={() => setQueueUndo(undefined)}
                >
                  <X size={17} />
                </Button>
              </div>
            </div>
          )}

          <section
            className="comparison"
            aria-label="Base and LUT comparison"
            aria-busy={selected ? selected.status === "decoding" : undefined}
            data-decode-count={preview?.decodeCount}
          >
            {!selected ? (
              <div className="workspace-empty">
                <div className="empty-icon">
                  <FileImage size={30} />
                </div>
                <h2>Start with a camera RAW</h2>
                <p>
                  Decode, compare, and export locally. The image never leaves
                  your browser.
                </p>
                <Button onClick={() => fileInput.current?.click()}>
                  <FolderOpen size={17} aria-hidden="true" /> Choose RAW files
                </Button>
              </div>
            ) : selected.status === "error" ? (
              <div className="processing-error-state">
                <FileImage size={30} aria-hidden="true" />
                <h2>Preview unavailable</h2>
                <p>
                  Remove this file or choose another RAW to continue. Other
                  ready files can still be exported.
                </p>
              </div>
            ) : !preview && cameraPreview?.fileId === selected.id ? (
              <figure className="camera-preview">
                <figcaption>
                  <strong>Camera preview</strong>
                  <span>Embedded JPEG · color not processed</span>
                </figcaption>
                <div className="camera-preview-image">
                  <img src={cameraPreview.url} alt="Embedded camera preview" />
                </div>
              </figure>
            ) : (
              <div
                className={`preview-grid ${selected.status === "decoding" ? "is-loading" : ""}`}
              >
                <PreviewCanvas
                  label="Base"
                  detail="Neutral tone map · sRGB"
                  pixels={preview?.base}
                  width={preview?.width}
                  height={preview?.height}
                />
                <PreviewCanvas
                  label={selectedLut?.name || "LUT"}
                  detail="V-Gamut · V-Log · LUT"
                  pixels={preview?.lut}
                  width={preview?.width}
                  height={preview?.height}
                />
                {selected.status === "decoding" && (
                  <div className="loading-label" role="status">
                    Decoding preview…
                  </div>
                )}
              </div>
            )}
          </section>

          {selected && (
            <section className="output-bar" aria-label="Export controls">
              <div className="selected-meta">
                <strong>{selected.file.name}</strong>
                <span>
                  {selected.status === "error"
                    ? "Unable to decode"
                    : selected.dimensions || STATUS_LABELS[selected.status]}
                </span>
              </div>
              <div className="export-feedback" aria-live="polite">
                {exportProgress ? (
                  <strong>
                    Exporting {exportProgress.current} of {exportProgress.total}
                    <span> · {exportProgress.fileName}</span>
                  </strong>
                ) : (
                  exportSummary && <span>{exportSummary}</span>
                )}
              </div>
              {exporting && exportProgress && exportProgress.total > 1 ? (
                <Button
                  variant="quiet"
                  disabled={exportProgress.stopRequested}
                  onClick={() => {
                    stopAfterCurrent.current = true;
                    setExportProgress((current) =>
                      current ? { ...current, stopRequested: true } : current,
                    );
                  }}
                >
                  <CircleStop size={16} aria-hidden="true" />
                  {exportProgress.stopRequested
                    ? "Stopping after current…"
                    : "Stop after current"}
                </Button>
              ) : (
                <Button
                  variant={items.length > 1 ? "secondary" : "primary"}
                  onClick={() => void exportItems([selected])}
                  disabled={
                    selected.status === "error" || exporting || !selectedLut
                  }
                >
                  Export selected
                </Button>
              )}
            </section>
          )}

          <footer className="workspace-footer">
            <span>
              Uses camera white balance and color matrix · automatic boost and
              lens correction are off.
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
