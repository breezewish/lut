import {
  Columns2,
  FolderOpen,
  ImageDown,
  LoaderCircle,
  LockKeyhole,
  Moon,
  Plus,
  RotateCcw,
  SplitSquareHorizontal,
  Sun,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Zip, ZipPassThrough } from "fflate";

import {
  CompareStage,
  type CompareMode,
  type StageImage,
} from "./components/compare-stage";
import { Filmstrip, type PhotoSelect } from "./components/filmstrip";
import { LookPanel } from "./components/look-panel";
import { Button } from "./components/ui/button";
import { ProcessingClient } from "./lib/processing-client";
import type { LutManifest, PreviewResult, QueueItem } from "./types";

const RAW_ACCEPT =
  ".3fr,.ari,.arw,.bay,.cap,.cr2,.cr3,.dcr,.dcs,.dng,.drf,.eip,.erf,.fff,.gpr,.iiq,.k25,.kdc,.mdc,.mef,.mos,.mrw,.nef,.nrw,.orf,.pef,.ptx,.pxn,.r3d,.raf,.raw,.rwl,.rw2,.rwz,.sr2,.srf,.srw,.x3f";
const DEFAULT_LUT_ID = "fuji-classic-negative";
const SETTLED_PREVIEW_MAX_EDGE = 1_024;
const THUMB_MAX_EDGE = 132;
const FILMSTRIP_THUMB_WIDTH = 220;
const GPU_EXPOSURE_PREVIEW_INTERVAL_MS = 16;

const PANEL_MIN = 240;
const PANEL_MAX = 560;
const STRIP_MIN = 76;
const STRIP_MAX = 320;

interface ExportProgress {
  current: number;
  total: number;
  fileName: string;
  stopRequested?: boolean;
}

interface QueueUndo {
  items: QueueItem[];
  activeId?: string;
  message: string;
}

type Theme = "light" | "dark";

const clamp = (value: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, value));

function readStoredSize(key: string, fallback: number, lo: number, hi: number) {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw > 0) return clamp(raw, lo, hi);
  } catch {
    // Persisted sizes are a convenience only.
  }
  return fallback;
}

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("raw-alchemy-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage is optional; the OS preference remains authoritative.
  }
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

interface DisplayedPreview {
  fileId: string;
  base?: StageImage;
  lut?: StageImage;
  decodeCount: number;
}

function isDecodeFailure(item: QueueItem): boolean {
  return item.status === "decode-error";
}
function hasUsablePreview(item: QueueItem): boolean {
  return (
    item.status === "ready" ||
    item.status === "done" ||
    item.status === "export-error"
  );
}
function previewRecipeKey(fileId: string, ev: number, lutId: string): string {
  return `${fileId}\n${ev}\n${lutId}`;
}
function basePreviewRecipeKey(fileId: string, ev: number): string {
  return `${fileId}\n${ev}`;
}

function mergePreview(
  current: DisplayedPreview | undefined,
  result: PreviewResult,
): DisplayedPreview {
  const image = (pixels: Uint8Array<ArrayBuffer>): StageImage => ({
    pixels,
    width: result.width,
    height: result.height,
  });
  return {
    fileId: result.fileId,
    base: result.base
      ? image(result.base)
      : current?.fileId === result.fileId
        ? current.base
        : undefined,
    lut: image(result.lut),
    decodeCount: result.decodeCount,
  };
}

/** Downscales a base preview buffer to a small filmstrip JPEG data URL. */
function makeThumbUrl(image: StageImage): string | undefined {
  const scale = Math.min(1, FILMSTRIP_THUMB_WIDTH / image.width);
  const tw = Math.max(1, Math.round(image.width * scale));
  const th = Math.max(1, Math.round(image.height * scale));
  const source = document.createElement("canvas");
  source.width = image.width;
  source.height = image.height;
  const sourceContext = source.getContext("2d");
  if (!sourceContext) return undefined;
  sourceContext.putImageData(
    new ImageData(
      new Uint8ClampedArray(
        image.pixels.buffer,
        image.pixels.byteOffset,
        image.pixels.byteLength,
      ),
      image.width,
      image.height,
    ),
    0,
    0,
  );
  const thumb = document.createElement("canvas");
  thumb.width = tw;
  thumb.height = th;
  const thumbContext = thumb.getContext("2d");
  if (!thumbContext) return undefined;
  thumbContext.drawImage(source, 0, 0, tw, th);
  return thumb.toDataURL("image/jpeg", 0.72);
}

export default function App() {
  const [client] = useState(() => new ProcessingClient());
  const [manifest, setManifest] = useState<LutManifest>();
  const [manifestError, setManifestError] = useState<string>();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<DisplayedPreview>();
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
  const [compareMode, setCompareMode] = useState<CompareMode>("wipe");
  const [dragOver, setDragOver] = useState(false);
  const [thumbs, setThumbs] = useState<Map<string, StageImage>>(new Map());
  const [thumbTick, setThumbTick] = useState(0);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [recentLutIds, setRecentLutIds] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem("raw-alchemy-recent-luts") ?? "[]",
      );
      return Array.isArray(stored) &&
        stored.every((value) => typeof value === "string")
        ? stored
        : [];
    } catch {
      return [];
    }
  });
  const [panelWidth, setPanelWidth] = useState(() =>
    readStoredSize("raw-alchemy-panel-w", 288, PANEL_MIN, PANEL_MAX),
  );
  const [stripHeight, setStripHeight] = useState(() =>
    readStoredSize("raw-alchemy-strip-h", 104, STRIP_MIN, STRIP_MAX),
  );

  const decodedFileId = useRef<string | undefined>(undefined);
  const settledBaseRecipe = useRef<string | undefined>(undefined);
  const nextPreviewGeneration = useRef(0);
  const lastPaintedGeneration = useRef(0);
  const desiredPreview = useRef<
    { generation: number; fileId: string; lutId: string } | undefined
  >(undefined);
  const [renderedRecipe, setRenderedRecipe] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const exposureInput = useRef<HTMLInputElement>(null);
  const exposureRange = useRef<HTMLInputElement>(null);
  const exposureCommitTimer = useRef<number | undefined>(undefined);
  const pendingExposure = useRef(0);
  const exposureHasPendingRecipe = useRef(false);
  const lastExposureCommitAt = useRef(0);
  const stopAfterCurrent = useRef(false);
  const thumbBusy = useRef(false);
  const failedThumbs = useRef(new Set<string>());
  const panelWidthRef = useRef(panelWidth);
  const stripHeightRef = useRef(stripHeight);

  // ── Derived active-photo recipe ──────────────────────────────────────────
  const active = items.find((item) => item.id === activeId);
  const ev = active?.ev ?? 0;
  const lutId = active?.lutId ?? DEFAULT_LUT_ID;
  const activeLut = manifest?.luts.find((lut) => lut.id === lutId);
  const currentRecipe = active
    ? previewRecipeKey(active.id, ev, lutId)
    : undefined;
  const isPreviewProcessing = Boolean(
    active &&
      activeLut &&
      !isDecodeFailure(active) &&
      (!hasUsablePreview(active) || renderedRecipe !== currentRecipe),
  );
  const eligibleSelected = items.filter(
    (item) => selectedIds.has(item.id) && !isDecodeFailure(item),
  );
  const selectedList = items.filter((item) => selectedIds.has(item.id));
  const mixedEv =
    selectedList.length > 1 &&
    new Set(selectedList.map((item) => item.ev)).size > 1;
  // Export stays gated on the active photo's visible recipe being fully
  // rendered, so batch export can't ship a recipe the user hasn't seen settle.
  const activeSettled = Boolean(
    active &&
      !isDecodeFailure(active) &&
      hasUsablePreview(active) &&
      renderedRecipe === currentRecipe,
  );
  const canExport = Boolean(
    !exporting && manifest && eligibleSelected.length > 0 && activeSettled,
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#1a1e24" : "#f0f1f4");
    try {
      localStorage.setItem("raw-alchemy-theme", theme);
    } catch {
      // Persisted theme is a convenience only.
    }
  }, [theme]);

  const setPanelW = useCallback((value: number) => {
    const next = clamp(value, PANEL_MIN, PANEL_MAX);
    panelWidthRef.current = next;
    setPanelWidth(next);
  }, []);
  const setStripH = useCallback((value: number) => {
    const next = clamp(value, STRIP_MIN, STRIP_MAX);
    stripHeightRef.current = next;
    setStripHeight(next);
  }, []);

  // Stable catalog order — the Looks grid must never reshuffle when a look is
  // picked, so it stays in the manifest's fixed (camera-family) order.
  const stripLooks = manifest?.luts ?? [];

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  const patchSelected = useCallback(
    (patch: Partial<Pick<QueueItem, "ev" | "lutId">>) => {
      setItems((current) =>
        current.map((item) =>
          selectedIds.has(item.id) ? { ...item, ...patch } : item,
        ),
      );
    },
    [selectedIds],
  );

  // ── Selection ────────────────────────────────────────────────────────────
  const selectPhoto = useCallback(
    (id: string, { additive, range }: PhotoSelect) => {
      if (range && activeId) {
        const from = items.findIndex((item) => item.id === activeId);
        const to = items.findIndex((item) => item.id === id);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setSelectedIds(new Set(items.slice(lo, hi + 1).map((i) => i.id)));
          setActiveId(id);
          return;
        }
      }
      if (additive) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          if (next.size === 0) next.add(id);
          setActiveId(next.has(id) ? id : [...next][0]);
          return next;
        });
        return;
      }
      setSelectedIds(new Set([id]));
      setActiveId(id);
    },
    [activeId, items],
  );

  // Reset the exposure input + look thumbnails whenever the active photo
  // changes; pending exposure follows the newly active photo.
  useEffect(() => {
    pendingExposure.current = active?.ev ?? 0;
    exposureHasPendingRecipe.current = false;
    setThumbs(new Map());
    failedThumbs.current = new Set();
    setThumbTick((tick) => tick + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Arrow-key photo navigation (single-select), when focus is outside a text
  // field. Photo buttons are allowed so arrows keep working inside the strip.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (items.length === 0) return;
      const index = items.findIndex((item) => item.id === activeId);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = items[clamp(index + delta, 0, items.length - 1)];
      if (next) {
        event.preventDefault();
        setSelectedIds(new Set([next.id]));
        setActiveId(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, activeId]);

  const setExposure = useCallback(
    (value: number) => {
      const next = clamp(value, -4, 4);
      pendingExposure.current = next;
      exposureHasPendingRecipe.current = true;
      setRenderedRecipe(undefined);
      if (exposureCommitTimer.current !== undefined) {
        window.clearTimeout(exposureCommitTimer.current);
        exposureCommitTimer.current = undefined;
      }
      lastExposureCommitAt.current = performance.now();
      patchSelected({ ev: next });
    },
    [patchSelected],
  );

  const scheduleExposurePreview = useCallback(
    (input: HTMLInputElement) => {
      const next = Number(input.value);
      pendingExposure.current = next;
      if (!exposureHasPendingRecipe.current) {
        exposureHasPendingRecipe.current = true;
        setRenderedRecipe(undefined);
      }
      input.style.setProperty("--range-progress", `${((next + 4) / 8) * 100}%`);
      input.setAttribute("aria-valuetext", `${next} EV`);
      if (exposureInput.current) exposureInput.current.value = String(next);
      if (exposureCommitTimer.current !== undefined) return;
      const elapsed = lastExposureCommitAt.current
        ? performance.now() - lastExposureCommitAt.current
        : 0;
      exposureCommitTimer.current = window.setTimeout(
        () => {
          exposureCommitTimer.current = undefined;
          lastExposureCommitAt.current = performance.now();
          startTransition(() => patchSelected({ ev: pendingExposure.current }));
        },
        Math.max(0, GPU_EXPOSURE_PREVIEW_INTERVAL_MS - elapsed),
      );
    },
    [patchSelected],
  );

  const chooseLut = useCallback(
    (value: string) => {
      patchSelected({ lutId: value });
      const next = Array.from(new Set([value, ...recentLutIds])).slice(0, 6);
      setRecentLutIds(next);
      try {
        localStorage.setItem("raw-alchemy-recent-luts", JSON.stringify(next));
      } catch {
        // Recent looks are a non-essential aid.
      }
    },
    [patchSelected, recentLutIds],
  );

  const releasePreview = useCallback(() => {
    decodedFileId.current = undefined;
    settledBaseRecipe.current = undefined;
    setRenderedRecipe(undefined);
    setPreview(undefined);
    setCameraPreview(undefined);
    void client.clear().catch((error: Error) => setGlobalError(error.message));
  }, [client]);

  useEffect(() => {
    let active = true;
    fetch(`${import.meta.env.BASE_URL}luts/manifest.json`)
      .then((response) => {
        if (!response.ok)
          throw new Error("The built-in LUT manifest could not be loaded.");
        return response.json() as Promise<LutManifest>;
      })
      .then((value) => {
        if (!Array.isArray(value.luts) || value.luts.length === 0) {
          throw new Error("The built-in LUT manifest is empty.");
        }
        if (active) setManifest(value);
      })
      .catch(() => {
        if (active)
          setManifestError("The built-in LUT manifest could not be loaded.");
      });
    return () => {
      active = false;
      client.dispose();
    };
  }, [client]);

  useEffect(() => {
    return client.onThumbnail(({ fileId, jpeg }) => {
      performance.mark("raw-alchemy:thumbnail");
      const url = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
      setCameraPreview({ fileId, url });
    });
  }, [client]);

  useEffect(() => {
    return client.onPreviewFrame((result) => {
      if (result.fileId !== activeId) return;
      setPreview((current) => mergePreview(current, result));
      setCameraPreview(undefined);
    });
  }, [client, activeId]);

  useEffect(
    () => () => {
      if (cameraPreview) URL.revokeObjectURL(cameraPreview.url);
    },
    [cameraPreview],
  );

  // Decode the active photo when it changes (using its own recipe).
  useEffect(() => {
    if (!active || !activeLut) return;
    let running = true;
    const decodeRecipe = previewRecipeKey(active.id, ev, activeLut.id);
    decodedFileId.current = undefined;
    settledBaseRecipe.current = undefined;
    desiredPreview.current = undefined;
    setRenderedRecipe(undefined);
    setPreview(undefined);
    setCameraPreview(undefined);
    setGlobalError(undefined);
    updateItem(active.id, { status: "decoding", error: undefined });

    const fileReadStartedAt = performance.now();
    active.file
      .arrayBuffer()
      .then((buffer) => {
        performance.mark("raw-alchemy:file-read", {
          detail: { durationMs: performance.now() - fileReadStartedAt },
        });
        return buffer;
      })
      .then((buffer) => client.decode(active.id, buffer, ev, activeLut))
      .then((result) => {
        if (!running) return;
        decodedFileId.current = active.id;
        settledBaseRecipe.current = basePreviewRecipeKey(active.id, ev);
        if (pendingExposure.current === ev)
          exposureHasPendingRecipe.current = false;
        setRenderedRecipe(decodeRecipe);
        setPreview(mergePreview(undefined, result));
        setCameraPreview(undefined);
        updateItem(active.id, {
          status: "ready",
          camera: result.metadata.camera || "Unknown camera",
          dimensions: `${result.metadata.width} × ${result.metadata.height}`,
        });
      })
      .catch((error: Error) => {
        if (!running) return;
        updateItem(active.id, { status: "decode-error", error: error.message });
        setGlobalError(error.message);
      });
    return () => {
      running = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, active?.id, Boolean(activeLut), updateItem]);

  // Re-render the settled comparison when EV or look changes (no re-decode).
  useEffect(() => {
    if (
      !active ||
      !activeLut ||
      !hasUsablePreview(active) ||
      decodedFileId.current !== active.id ||
      (exposureHasPendingRecipe.current && pendingExposure.current !== ev)
    )
      return;
    const recipe = previewRecipeKey(active.id, ev, activeLut.id);
    if (renderedRecipe === recipe) return;
    const generation = ++nextPreviewGeneration.current;
    desiredPreview.current = {
      generation,
      fileId: active.id,
      lutId: activeLut.id,
    };
    const baseRecipe = basePreviewRecipeKey(active.id, ev);
    const includeBase = settledBaseRecipe.current !== baseRecipe;
    let running = true;
    const render = async () => {
      try {
        const frame = await client.render(active.id, ev, activeLut, {
          maxEdge: SETTLED_PREVIEW_MAX_EDGE,
          includeBase,
        });
        const desired = desiredPreview.current;
        if (
          desired?.fileId === active.id &&
          desired.lutId === activeLut.id &&
          generation > lastPaintedGeneration.current
        ) {
          lastPaintedGeneration.current = generation;
          setPreview((current) => mergePreview(current, frame));
        }
        if (!running) return;
        if (pendingExposure.current !== ev) return;
        settledBaseRecipe.current = baseRecipe;
        exposureHasPendingRecipe.current = false;
        setRenderedRecipe(recipe);
      } catch (error) {
        if (running)
          setGlobalError(
            error instanceof Error ? error.message : String(error),
          );
      }
    };
    void render();
    return () => {
      running = false;
      if (desiredPreview.current?.generation === generation)
        desiredPreview.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, ev, renderedRecipe, active?.id, active?.status, activeLut?.id]);

  // Progressive look thumbnails for the active photo's Looks panel.
  useEffect(() => {
    if (
      !active ||
      !activeLut ||
      !manifest ||
      exporting ||
      isPreviewProcessing ||
      thumbBusy.current ||
      decodedFileId.current !== active.id ||
      !hasUsablePreview(active)
    )
      return;
    const next = manifest.luts.find(
      (lut) => !thumbs.has(lut.id) && !failedThumbs.current.has(lut.id),
    );
    if (!next) return;
    const fileId = active.id;
    thumbBusy.current = true;
    let running = true;
    client
      .render(fileId, active.ev, next, {
        maxEdge: THUMB_MAX_EDGE,
        includeBase: false,
      })
      .then((result) => {
        if (!running || decodedFileId.current !== fileId) return;
        setThumbs((current) => {
          const map = new Map(current);
          map.set(next.id, {
            pixels: result.lut,
            width: result.width,
            height: result.height,
          });
          return map;
        });
      })
      .catch(() => {
        failedThumbs.current.add(next.id);
        if (running) setThumbTick((tick) => tick + 1);
      })
      .finally(() => {
        thumbBusy.current = false;
      });
    return () => {
      running = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    client,
    manifest,
    active,
    activeLut,
    exporting,
    isPreviewProcessing,
    thumbs,
    thumbTick,
  ]);

  // Build a filmstrip thumbnail once the active photo's base preview lands.
  useEffect(() => {
    if (!active || active.thumbUrl || !preview?.base) return;
    if (preview.fileId !== active.id) return;
    const url = makeThumbUrl(preview.base);
    if (url) updateItem(active.id, { thumbUrl: url });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, active?.id, active?.thumbUrl, updateItem]);

  // Keep the exposure controls in sync with the active photo's EV.
  useEffect(() => {
    if (
      exposureInput.current &&
      document.activeElement !== exposureInput.current
    ) {
      exposureInput.current.value = String(ev);
    }
    if (exposureRange.current && pendingExposure.current === ev) {
      exposureRange.current.value = String(ev);
      exposureRange.current.style.setProperty(
        "--range-progress",
        `${((ev + 4) / 8) * 100}%`,
      );
      exposureRange.current.setAttribute("aria-valuetext", `${ev} EV`);
    }
  }, [ev]);

  useEffect(
    () => () => {
      if (exposureCommitTimer.current !== undefined)
        window.clearTimeout(exposureCommitTimer.current);
    },
    [],
  );

  // ── File intake ──────────────────────────────────────────────────────────
  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    performance.mark("raw-alchemy:file-selected");
    setGlobalError(undefined);
    setQueueUndo(undefined);
    setExportSummary(undefined);
    const first = files[0];
    const firstId = `${first.name}:${first.size}:${first.lastModified}`;
    setActiveId((current) => current ?? firstId);
    setSelectedIds((current) =>
      current.size > 0 ? current : new Set([firstId]),
    );
    setItems((current) => {
      const existing = new Set(current.map((item) => item.id));
      const additions: QueueItem[] = [];
      for (const file of files) {
        const id = `${file.name}:${file.size}:${file.lastModified}`;
        if (existing.has(id)) continue;
        existing.add(id);
        additions.push({
          id,
          file,
          status: "queued",
          ev: 0,
          lutId: DEFAULT_LUT_ID,
        });
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
    setDragOver(false);
    if (exporting) return;
    addFiles(Array.from(event.dataTransfer.files));
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!exporting) setDragOver(true);
  };

  const removeItem = (id: string) => {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) return;
    setQueueUndo({
      items: [item],
      activeId: activeId === id ? id : undefined,
      message: `Removed ${item.file.name}`,
    });
    const remaining = items.filter((candidate) => candidate.id !== id);
    setItems(remaining);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      if (next.size === 0 && remaining[0]) next.add(remaining[0].id);
      return next;
    });
    if (activeId === id) {
      const next = remaining[0];
      setActiveId(next?.id);
      releasePreview();
    }
  };

  const clearQueue = () => {
    setQueueUndo({
      items,
      activeId,
      message: `Cleared ${items.length} photo${items.length === 1 ? "" : "s"}`,
    });
    setItems([]);
    setActiveId(undefined);
    setSelectedIds(new Set());
    setExportSummary(undefined);
    releasePreview();
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
    if (queueUndo.activeId) {
      setActiveId(queueUndo.activeId);
      setSelectedIds(new Set([queueUndo.activeId]));
    }
    setQueueUndo(undefined);
  };

  // ── Export ───────────────────────────────────────────────────────────────
  const exportSelected = async () => {
    const targets = eligibleSelected;
    if (!manifest || exporting || targets.length === 0) return;
    const single = targets.length === 1;
    setExporting(true);
    setGlobalError(undefined);
    setExportSummary(undefined);
    stopAfterCurrent.current = false;
    const outputNames = new Set<string>();
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
    let lutId = DEFAULT_LUT_ID;

    try {
      for (const [index, item] of targets.entries()) {
        const lut = manifest.luts.find(
          (candidate) => candidate.id === item.lutId,
        );
        if (!lut) {
          failed.push(item.file.name);
          continue;
        }
        lutId = lut.id;
        setExportProgress({
          current: index + 1,
          total: targets.length,
          fileName: item.file.name,
        });
        updateItem(item.id, { status: "exporting", error: undefined });
        let tiff: Uint8Array | undefined;
        try {
          const exported = await client.export(
            item.id,
            await item.file.arrayBuffer(),
            item.ev,
            lut,
          );
          tiff = exported.tiff;
          performance.mark("raw-alchemy:export-worker", {
            detail: exported.timings,
          });
        } catch (error) {
          failed.push(item.file.name);
          updateItem(item.id, {
            status: "export-error",
            error: error instanceof Error ? error.message : String(error),
          });
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
          const stem = `${base}-${lut.id}`;
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
          { type: single ? "image/tiff" : "application/zip" },
        );
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = single
          ? singleOutput!.name
          : `raw-alchemy-${lutId}.zip`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }

      const detail = failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : "";
      setExportSummary(
        stopped
          ? `Stopped after ${outputNames.size} of ${targets.length} exports.${detail}`
          : `Exported ${outputNames.size} of ${targets.length}.${detail}`,
      );
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportProgress(undefined);
      setExporting(false);
    }
  };

  // ── Resizers ─────────────────────────────────────────────────────────────
  const startPanelResize = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = panelWidthRef.current;
    const move = (moveEvent: PointerEvent) =>
      setPanelW(startWidth - (moveEvent.clientX - startX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(
          "raw-alchemy-panel-w",
          String(panelWidthRef.current),
        );
      } catch {
        // Persisted layout is a convenience only.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const startStripResize = (event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = stripHeightRef.current;
    const move = (moveEvent: PointerEvent) =>
      setStripH(startHeight - (moveEvent.clientY - startY));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(
          "raw-alchemy-strip-h",
          String(stripHeightRef.current),
        );
      } catch {
        // Persisted layout is a convenience only.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onPanelResizeKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowLeft") setPanelW(panelWidthRef.current + 24);
    else if (event.key === "ArrowRight") setPanelW(panelWidthRef.current - 24);
    else return;
    event.preventDefault();
  };
  const onStripResizeKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowUp") setStripH(stripHeightRef.current + 24);
    else if (event.key === "ArrowDown") setStripH(stripHeightRef.current - 24);
    else return;
    event.preventDefault();
  };

  const hasPhotos = items.length > 0;
  const showCompare = Boolean(active && activeLut && !isDecodeFailure(active));
  const showCamera = Boolean(
    !preview && cameraPreview && active && cameraPreview.fileId === active.id,
  );

  return (
    <div
      className="app"
      style={
        {
          "--panel-w": `${panelWidth}px`,
          "--strip-h": `${stripHeight}px`,
        } as CSSProperties
      }
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="header">
        <div className="brand">
          <svg
            className="brand__mark"
            viewBox="0 0 22 22"
            aria-hidden="true"
            fill="none"
          >
            <circle
              cx="11"
              cy="11"
              r="9.25"
              stroke="var(--accent)"
              opacity="0.5"
            />
            <path
              d="M11 1.75 A9.25 9.25 0 0 1 11 20.25 Z"
              fill="var(--accent)"
            />
          </svg>
          <h1 className="brand__name">RAW Alchemy</h1>
        </div>
        <div
          className="header__doc"
          aria-label="Current document"
          aria-live="polite"
        >
          {active ? (
            <>
              <span className="header__name">{active.file.name}</span>
              {active.dimensions && (
                <span className="header__dims">{active.dimensions}</span>
              )}
              {selectedIds.size > 1 && (
                <span className="header__count">
                  {selectedIds.size} selected
                </span>
              )}
            </>
          ) : hasPhotos ? (
            <span className="header__dims">Select a photo</span>
          ) : (
            <span className="header__dims">Local RAW processing</span>
          )}
        </div>
        <div className="header__actions">
          <span className="shield">
            <LockKeyhole size={13} aria-hidden="true" />
            <span>Files stay on this device</span>
          </span>
          <Button
            size="icon"
            variant="quiet"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? (
              <Sun size={16} aria-hidden="true" />
            ) : (
              <Moon size={16} aria-hidden="true" />
            )}
          </Button>
          <Button
            variant="secondary"
            aria-label="Add RAW files"
            disabled={exporting}
            onClick={() => fileInput.current?.click()}
          >
            <Plus size={15} aria-hidden="true" />
            <span className="hide-narrow">Add RAWs</span>
          </Button>
        </div>
      </header>

      <div className="workspace">
        <section
          className="viewer"
          aria-label="Base and LUT comparison"
          aria-busy={active ? isPreviewProcessing : undefined}
          data-decode-count={preview?.decodeCount}
        >
          {showCompare && (
            <div className="viewer__tools">
              <div className="seg" aria-label="Comparison mode">
                <button
                  type="button"
                  aria-pressed={compareMode === "wipe"}
                  onClick={() => setCompareMode("wipe")}
                >
                  <Columns2 size={14} aria-hidden="true" /> Wipe
                </button>
                <button
                  type="button"
                  aria-pressed={compareMode === "split"}
                  onClick={() => setCompareMode("split")}
                >
                  <SplitSquareHorizontal size={14} aria-hidden="true" /> Split
                </button>
              </div>
              {!isPreviewProcessing && (
                <span className="viewer__status">Ready</span>
              )}
            </div>
          )}
          {!hasPhotos ? (
            <div className={`empty ${dragOver ? "is-drag" : ""}`}>
              <div className="empty__icon">
                <FolderOpen size={26} aria-hidden="true" />
              </div>
              <h2 className="empty__title">Start with a camera RAW</h2>
              <p className="empty__copy">
                Drop photos anywhere to compare a neutral rendering against a
                curated look, then export a{" "}
                <span style={{ whiteSpace: "nowrap" }}>16-bit TIFF</span>.
              </p>
              <Button onClick={() => fileInput.current?.click()}>
                <FolderOpen size={17} aria-hidden="true" /> Choose RAW files
              </Button>
              <span className="empty__detail">
                <LockKeyhole size={13} aria-hidden="true" />
                Files stay on this device
              </span>
            </div>
          ) : !active ? (
            <div className="empty">
              <p className="empty__copy">Select a photo to begin.</p>
            </div>
          ) : !activeLut ? (
            <div className="overlay-note" role="status">
              {manifestError
                ? "Built-in looks unavailable. Reload to retry."
                : "Loading looks…"}
            </div>
          ) : isDecodeFailure(active) ? (
            <div className="overlay-note" role="status">
              <TriangleAlert size={16} aria-hidden="true" />
              Preview unavailable — remove this file or choose another RAW.
            </div>
          ) : showCamera ? (
            <figure className="camera">
              <img src={cameraPreview!.url} alt="Embedded camera preview" />
            </figure>
          ) : (
            <>
              <CompareStage
                base={preview?.base}
                look={preview?.lut}
                lookLabel={activeLut.name}
                mode={compareMode}
                resetKey={active.id}
                isLoading={active.status === "decoding"}
              />
              {active.status === "decoding" && preview && (
                <div className="overlay-note" role="status">
                  <LoaderCircle
                    size={16}
                    className="spin"
                    aria-hidden="true"
                  />
                  Decoding preview…
                </div>
              )}
            </>
          )}
        </section>

        {hasPhotos && (
          <>
            <div
              className="splitter splitter--v"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panels"
              aria-valuenow={Math.round(panelWidth)}
              aria-valuemin={PANEL_MIN}
              aria-valuemax={PANEL_MAX}
              tabIndex={0}
              onPointerDown={startPanelResize}
              onKeyDown={onPanelResizeKey}
            />

            <aside className="panels" aria-label="Adjustments">
              <div className="panel">
                <div className="panel__head">
                  <span className="panel__title">Exposure</span>
                  <div className="panel__tools">
                    {isPreviewProcessing && (
                      <span
                        className="processing"
                        role="status"
                        aria-label="Preview processing"
                      >
                        <LoaderCircle size={12} aria-hidden="true" />
                        Processing
                      </span>
                    )}
                    <Button
                      size="icon"
                      variant="quiet"
                      aria-label="Reset exposure"
                      onClick={() => setExposure(0)}
                      disabled={exporting || ev === 0 || !active}
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div className="expo">
                  <div className="expo__row">
                    <label className="expo__label" htmlFor="exposure">
                      {selectedIds.size > 1
                        ? `EV · ${selectedIds.size} photos${mixedEv ? " · mixed" : ""}`
                        : "EV"}
                    </label>
                    <label className="expo__value">
                      <input
                        ref={exposureInput}
                        aria-label="Exposure value"
                        type="number"
                        min="-4"
                        max="4"
                        step="0.1"
                        defaultValue={ev}
                        disabled={exporting || !active}
                        onChange={(event) => {
                          const value = event.currentTarget.valueAsNumber;
                          if (Number.isFinite(value)) setExposure(value);
                        }}
                        onBlur={(event) => {
                          event.currentTarget.value = String(ev);
                        }}
                      />
                      <span>EV</span>
                    </label>
                  </div>
                  <input
                    ref={exposureRange}
                    id="exposure"
                    type="range"
                    aria-label="Exposure"
                    min="-4"
                    max="4"
                    step="0.1"
                    defaultValue={ev}
                    aria-valuetext={`${ev} EV`}
                    disabled={exporting || !active}
                    style={
                      {
                        "--range-progress": `${((ev + 4) / 8) * 100}%`,
                      } as CSSProperties
                    }
                    onInput={(event) =>
                      scheduleExposurePreview(event.currentTarget)
                    }
                    onChange={(event) =>
                      scheduleExposurePreview(event.currentTarget)
                    }
                  />
                  <div className="expo__ticks" aria-hidden="true">
                    {Array.from({ length: 9 }, (_, index) => (
                      <span key={index} />
                    ))}
                  </div>
                  <div className="expo__scale" aria-hidden="true">
                    <span>−4</span>
                    <span>0</span>
                    <span>+4</span>
                  </div>
                </div>
              </div>

              <div className="panel panel--looks">
                <div className="panel__head">
                  <span className="panel__title">
                    Looks{manifest ? ` · ${manifest.luts.length}` : ""}
                  </span>
                </div>
                {manifest ? (
                  <LookPanel
                    looks={stripLooks}
                    activeId={lutId}
                    onChoose={chooseLut}
                    thumbs={thumbs}
                    query={lookQuery}
                    onQuery={setLookQuery}
                    disabled={exporting || !active}
                  />
                ) : (
                  <p className="export-note">
                    {manifestError ?? "Loading built-in looks…"}
                  </p>
                )}
              </div>

              <div className="panel" aria-label="Output">
                <div className="panel__head">
                  <span className="panel__title">Output</span>
                </div>
                <dl className="spec">
                  <div>
                    <dt>Camera</dt>
                    <dd>{active?.camera || "—"}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{active?.dimensions || "—"}</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>16-bit TIFF</dd>
                  </div>
                </dl>
                <details className="disclose">
                  <summary>
                    <TriangleAlert size={14} aria-hidden="true" />
                    Unverified color
                  </summary>
                  <div className="disclose__body">
                    <p>
                      Built-in looks do not declare an output color space, so
                      another editor may interpret the TIFF differently. Check
                      the result before production use.
                    </p>
                    <p>
                      The preview shows the LUT values as sRGB. The exported
                      TIFF intentionally carries no embedded profile rather than
                      claiming one the source LUT does not provide.
                    </p>
                  </div>
                </details>
                <div className="export-note" aria-live="polite">
                  {exportProgress ? (
                    <>
                      <strong>
                        {exportProgress.current} / {exportProgress.total}
                      </strong>{" "}
                      {exportProgress.fileName}
                    </>
                  ) : exportSummary ? (
                    exportSummary
                  ) : active?.status === "export-error" ? (
                    <span className="export-note--error">{active.error}</span>
                  ) : (
                    "Full-resolution processing starts on export."
                  )}
                </div>
                {exporting && exportProgress && exportProgress.total > 1 ? (
                  <Button
                    size="block"
                    variant="secondary"
                    disabled={exportProgress.stopRequested}
                    onClick={() => {
                      stopAfterCurrent.current = true;
                      setExportProgress((current) =>
                        current ? { ...current, stopRequested: true } : current,
                      );
                    }}
                  >
                    {exportProgress.stopRequested
                      ? "Stopping…"
                      : "Stop after current"}
                  </Button>
                ) : (
                  <Button
                    size="block"
                    variant="primary"
                    onClick={() => void exportSelected()}
                    disabled={!canExport}
                  >
                    <ImageDown size={16} aria-hidden="true" />
                    {eligibleSelected.length > 1
                      ? `Export ${eligibleSelected.length} photos`
                      : "Export photo"}
                  </Button>
                )}
              </div>
            </aside>
          </>
        )}
      </div>

      <div
        className="splitter splitter--h"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize filmstrip"
        aria-valuenow={Math.round(stripHeight)}
        aria-valuemin={STRIP_MIN}
        aria-valuemax={STRIP_MAX}
        tabIndex={0}
        onPointerDown={startStripResize}
        onKeyDown={onStripResizeKey}
      />

      <div className="filmstrip-wrap">
        <Filmstrip
          items={items}
          activeId={activeId}
          selectedIds={selectedIds}
          exporting={exporting}
          onSelect={selectPhoto}
          onRemove={removeItem}
          onAdd={() => fileInput.current?.click()}
        />
      </div>

      <div className="toasts">
        {manifestError && (
          <div className="toast toast--error" role="alert">
            <span className="toast__body">{manifestError}</span>
            <div className="toast__actions">
              <Button variant="secondary" onClick={() => location.reload()}>
                Reload
              </Button>
            </div>
          </div>
        )}
        {globalError && (
          <div className="toast toast--error" role="alert">
            <span className="toast__body">{globalError}</span>
            <div className="toast__actions">
              {active && isDecodeFailure(active) && (
                <Button
                  variant="secondary"
                  onClick={() => removeItem(active.id)}
                >
                  Remove file
                </Button>
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
          <div className="toast" role="status">
            <span className="toast__body">{queueUndo.message}</span>
            <div className="toast__actions">
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
      </div>

      <input
        ref={fileInput}
        className="sr-only"
        tabIndex={-1}
        type="file"
        accept={RAW_ACCEPT}
        multiple
        disabled={exporting}
        onChange={onFileInput}
      />
    </div>
  );
}
