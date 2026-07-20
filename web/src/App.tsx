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
  type PixelStageImage,
  type StageImage,
} from "./components/compare-stage";
import { Filmstrip, type PhotoSelect } from "./components/filmstrip";
import { LookPanel, type LookThumbImage } from "./components/look-panel";
import { UnsupportedRawDialog } from "./components/unsupported-raw-dialog";
import { Button } from "./components/ui/button";
import {
  getUnsupportedRawFormat,
  type UnsupportedRawFormat,
} from "./lib/errors";
import { ProcessingClient } from "./lib/processing-client";
import type {
  DisplayPreviewResult,
  LutManifest,
  OutputFormat,
  PreviewResult,
  QueueItem,
} from "./types";

const RAW_ACCEPT =
  ".3fr,.arq,.arw,.bay,.cap,.cr2,.cr3,.dcr,.dcs,.dng,.drf,.eip,.erf,.fff,.gpr,.iiq,.k25,.kdc,.mdc,.mef,.mos,.mrw,.nef,.nrw,.orf,.pef,.ptx,.pxn,.raf,.raw,.rwl,.rw2,.rwz,.sr2,.srf,.srw,.x3f";
const DEFAULT_LUT_ID = "fuji-classic-negative";
const SETTLED_PREVIEW_MAX_EDGE = 1_024;
const INTERACTION_PREVIEW_MAX_EDGE = 256;
const THUMB_MAX_EDGE = 132;
const FILMSTRIP_THUMB_WIDTH = 220;
const GPU_EXPOSURE_PREVIEW_INTERVAL_MS = 16;
const EXPOSURE_SETTLE_DELAY_MS = 80;
const UI_PREVIEW_CACHE_LIMIT = 3;

const OUTPUT_FORMATS: Record<
  OutputFormat,
  { label: string; extension: string; mime: string }
> = {
  tiff: { label: "TIFF", extension: "tif", mime: "image/tiff" },
  jpeg: { label: "JPEG", extension: "jpg", mime: "image/jpeg" },
};

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
    const saved = localStorage.getItem("lutify-theme");
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

interface CachedDisplayedPreview {
  recipe: string;
  preview: DisplayedPreview;
}

interface CachedLookThumbs {
  recipe: string;
  images: Map<string, LookThumbImage>;
}

const EMPTY_LOOK_THUMBS = new Map<string, LookThumbImage>();

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

/** Preserves portrait and square framing without widening landscape tiles. */
function thumbnailAspectRatio(width: number, height: number): number {
  return width > height ? 3 / 2 : width / height;
}

function previewRecipeKey(
  fileId: string,
  ev: number,
  temperature: number,
  tint: number,
  lutId: string,
): string {
  return `${fileId}\n${ev}\n${temperature}\n${tint}\n${lutId}`;
}
function basePreviewRecipeKey(
  fileId: string,
  ev: number,
  temperature: number,
  tint: number,
): string {
  return `${fileId}\n${ev}\n${temperature}\n${tint}`;
}

function rememberCacheEntry<Key, Value>(
  cache: Map<Key, Value>,
  key: Key,
  value: Value,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > UI_PREVIEW_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

function mergePreview(
  current: DisplayedPreview | undefined,
  result: DisplayPreviewResult,
): DisplayedPreview {
  const bitmapResult = "lutBitmap" in result;
  const base = bitmapResult ? result.baseBitmap : result.base;
  const lut = bitmapResult ? result.lutBitmap : result.lut;
  const image = (source: Uint8Array<ArrayBuffer> | ImageBitmap): StageImage =>
    source instanceof Uint8Array
      ? { pixels: source, width: result.width, height: result.height }
      : { bitmap: source, width: result.width, height: result.height };
  return {
    fileId: result.fileId,
    base: base
      ? image(base)
      : current?.fileId === result.fileId
        ? current.base
        : undefined,
    lut: image(lut),
    decodeCount: result.decodeCount,
  };
}

function releasePreviewBitmaps(
  preview: DisplayedPreview,
  retained?: DisplayedPreview,
): void {
  for (const image of [preview.base, preview.lut]) {
    if (
      image &&
      "bitmap" in image &&
      image !== retained?.base &&
      image !== retained?.lut
    ) {
      image.bitmap.close();
    }
  }
}

function rememberPreviewCacheEntry(
  cache: Map<string, CachedDisplayedPreview>,
  key: string,
  value: CachedDisplayedPreview,
): void {
  const previous = cache.get(key);
  if (previous && previous !== value) {
    releasePreviewBitmaps(previous.preview, value.preview);
  }
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > UI_PREVIEW_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return;
    const oldest = cache.get(oldestKey);
    if (oldest) releasePreviewBitmaps(oldest.preview);
    cache.delete(oldestKey);
  }
}

function clearPreviewCache(cache: Map<string, CachedDisplayedPreview>): void {
  for (const entry of cache.values()) releasePreviewBitmaps(entry.preview);
  cache.clear();
}

/** Downscales a base preview buffer to a small filmstrip JPEG data URL. */
function makeThumbUrl(image: PixelStageImage): string | undefined {
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
  const [unsupportedRaw, setUnsupportedRaw] = useState<UnsupportedRawFormat>();
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress>();
  const [exportSummary, setExportSummary] = useState<string>();
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("tiff");
  const [queueUndo, setQueueUndo] = useState<QueueUndo>();
  const [lookQuery, setLookQuery] = useState("");
  const [compareMode, setCompareMode] = useState<CompareMode>("wipe");
  const [dragOver, setDragOver] = useState(false);
  const [thumbs, setThumbs] = useState<Map<string, LookThumbImage>>(new Map());
  const [thumbBatchTick, setThumbBatchTick] = useState(0);
  const [filmstripThumbTick, setFilmstripThumbTick] = useState(0);
  const [sourceTick, setSourceTick] = useState(0);
  const [exposureInteracting, setExposureInteracting] = useState(false);
  const [whiteBalanceInteracting, setWhiteBalanceInteracting] = useState(false);
  const [interactionExposure, setInteractionExposure] = useState<{
    fileId: string;
    ev: number;
  }>();
  const [interactionLookRecipe, setInteractionLookRecipe] = useState<string>();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [panelWidth, setPanelWidth] = useState(() =>
    readStoredSize("lutify-panel-w", 288, PANEL_MIN, PANEL_MAX),
  );
  const [stripHeight, setStripHeight] = useState(() =>
    readStoredSize("lutify-strip-h", 104, STRIP_MIN, STRIP_MAX),
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
  const temperatureInput = useRef<HTMLInputElement>(null);
  const temperatureRange = useRef<HTMLInputElement>(null);
  const tintInput = useRef<HTMLInputElement>(null);
  const tintRange = useRef<HTMLInputElement>(null);
  const whiteBalanceSettleTimer = useRef<number | undefined>(undefined);
  const exposureCommitTimer = useRef<number | undefined>(undefined);
  const exposureSettleTimer = useRef<number | undefined>(undefined);
  const pendingExposure = useRef(0);
  const committedExposure = useRef(0);
  const persistedExposure = useRef(0);
  const exposureHasPendingRecipe = useRef(false);
  const exposureRenderBusy = useRef(false);
  const previewRendersInFlight = useRef(0);
  const lastExposureCommitAt = useRef(0);
  const stopAfterCurrent = useRef(false);
  const thumbBusy = useRef(false);
  const failedThumbRecipe = useRef<string | undefined>(undefined);
  const attemptedFilmstripThumbs = useRef(new Set<string>());
  const filmstripThumbBusy = useRef(false);
  const filmstripThumbUrls = useRef(new Map<string, string>());
  const previewCache = useRef(new Map<string, CachedDisplayedPreview>());
  const lookThumbCache = useRef(new Map<string, CachedLookThumbs>());
  const displayedThumbFileId = useRef<string | undefined>(undefined);
  const panelWidthRef = useRef(panelWidth);
  const stripHeightRef = useRef(stripHeight);

  // ── Derived active-photo recipe ──────────────────────────────────────────
  const active = items.find((item) => item.id === activeId);
  const ev =
    active && interactionExposure?.fileId === active.id
      ? interactionExposure.ev
      : (active?.ev ?? 0);
  const lutId = active?.lutId ?? DEFAULT_LUT_ID;
  const temperature = active?.temperature ?? 0;
  const tint = active?.tint ?? 0;
  const whiteBalance = { temperature, tint };
  const activeLut = manifest?.luts.find((lut) => lut.id === lutId);
  const currentRecipe = active
    ? previewRecipeKey(active.id, ev, temperature, tint, lutId)
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
  const mixedWhiteBalance =
    selectedList.length > 1 &&
    (new Set(selectedList.map((item) => item.temperature)).size > 1 ||
      new Set(selectedList.map((item) => item.tint)).size > 1);
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
      localStorage.setItem("lutify-theme", theme);
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
    (
      patch: Partial<Pick<QueueItem, "ev" | "temperature" | "tint" | "lutId">>,
    ) => {
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

  // Switching photos replaces the exposure scheduling domain. Never reset
  // these refs for an EV update: a render may still be working on an older EV
  // while pendingExposure already holds the user's newest slider position.
  useEffect(() => {
    setInteractionExposure(undefined);
    setInteractionLookRecipe(undefined);
    setWhiteBalanceInteracting(false);
    pendingExposure.current = active?.ev ?? 0;
    committedExposure.current = active?.ev ?? 0;
    persistedExposure.current = active?.ev ?? 0;
    exposureHasPendingRecipe.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Restore exact thumbnails when cached. For a new EV, retain the visible
  // previous recipe while a separate empty cache entry tracks which new
  // results have arrived. Each tile is then replaced in place.
  useEffect(() => {
    const cached = active ? lookThumbCache.current.get(active.id) : undefined;
    const recipe = active
      ? basePreviewRecipeKey(active.id, ev, temperature, tint)
      : undefined;
    if (active && cached && cached.recipe === recipe) {
      rememberCacheEntry(lookThumbCache.current, active.id, cached);
      setThumbs(new Map(cached.images));
      displayedThumbFileId.current = active.id;
    } else {
      if (active) {
        rememberCacheEntry(lookThumbCache.current, active.id, {
          recipe: recipe!,
          images: new Map(),
        });
      }
      if (!active || displayedThumbFileId.current !== active.id) {
        setThumbs(active && cached ? new Map(cached.images) : new Map());
        displayedThumbFileId.current = active?.id;
      }
    }
    failedThumbRecipe.current = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, ev, temperature, tint]);

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
      if (exposureSettleTimer.current !== undefined) {
        window.clearTimeout(exposureSettleTimer.current);
        exposureSettleTimer.current = undefined;
      }
      setExposureInteracting(false);
      setInteractionExposure(undefined);
      pendingExposure.current = next;
      committedExposure.current = next;
      persistedExposure.current = next;
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

  const schedulePendingExposureRender = useCallback(() => {
    if (
      pendingExposure.current === committedExposure.current ||
      exposureRenderBusy.current ||
      exposureCommitTimer.current !== undefined
    )
      return;
    const elapsed = lastExposureCommitAt.current
      ? performance.now() - lastExposureCommitAt.current
      : 0;
    exposureCommitTimer.current = window.setTimeout(
      () => {
        exposureCommitTimer.current = undefined;
        if (exposureRenderBusy.current) return;
        lastExposureCommitAt.current = performance.now();
        const next = pendingExposure.current;
        committedExposure.current = next;
        if (activeId) setInteractionExposure({ fileId: activeId, ev: next });
      },
      Math.max(0, GPU_EXPOSURE_PREVIEW_INTERVAL_MS - elapsed),
    );
  }, [activeId]);

  const persistPendingExposure = useCallback(() => {
    const next = pendingExposure.current;
    if (!activeId) return;
    if (exposureCommitTimer.current !== undefined) {
      window.clearTimeout(exposureCommitTimer.current);
      exposureCommitTimer.current = undefined;
    }
    committedExposure.current = next;
    setInteractionExposure(undefined);
    if (persistedExposure.current === next) return;
    persistedExposure.current = next;
    patchSelected({ ev: next });
  }, [activeId, patchSelected]);

  const finishExposureGesture = useCallback(() => {
    if (exposureSettleTimer.current !== undefined) {
      window.clearTimeout(exposureSettleTimer.current);
      exposureSettleTimer.current = undefined;
    }
    setExposureInteracting(false);
    persistPendingExposure();
  }, [persistPendingExposure]);

  const scheduleExposurePreview = useCallback(
    (input: HTMLInputElement) => {
      const next = Number(input.value);
      pendingExposure.current = next;
      if (!exposureHasPendingRecipe.current) {
        exposureHasPendingRecipe.current = true;
        setRenderedRecipe(undefined);
      }
      setExposureInteracting(true);
      if (exposureSettleTimer.current !== undefined) {
        window.clearTimeout(exposureSettleTimer.current);
      }
      exposureSettleTimer.current = window.setTimeout(() => {
        exposureSettleTimer.current = undefined;
        setExposureInteracting(false);
        persistPendingExposure();
      }, EXPOSURE_SETTLE_DELAY_MS);
      input.style.setProperty("--range-progress", `${((next + 4) / 8) * 100}%`);
      input.setAttribute("aria-valuetext", `${next} EV`);
      if (exposureInput.current) exposureInput.current.value = String(next);
      if (active && hasUsablePreview(active)) schedulePendingExposureRender();
    },
    [active, persistPendingExposure, schedulePendingExposureRender],
  );

  const chooseLut = useCallback(
    (value: string) => {
      if (!active || value === active.lutId) return;
      setInteractionLookRecipe(
        previewRecipeKey(active.id, ev, temperature, tint, value),
      );
      patchSelected({ lutId: value });
    },
    [active, ev, temperature, tint, patchSelected],
  );

  const setWhiteBalance = useCallback(
    (next: Partial<Pick<QueueItem, "temperature" | "tint">>) => {
      if (whiteBalanceSettleTimer.current !== undefined) {
        window.clearTimeout(whiteBalanceSettleTimer.current);
        whiteBalanceSettleTimer.current = undefined;
      }
      setWhiteBalanceInteracting(false);
      setRenderedRecipe(undefined);
      patchSelected(next);
    },
    [patchSelected],
  );

  const scheduleWhiteBalancePreview = useCallback(
    (axis: "temperature" | "tint", input: HTMLInputElement) => {
      const value = Number(input.value);
      const output = axis === "temperature" ? temperatureInput : tintInput;
      if (output.current) output.current.value = String(value);
      setWhiteBalanceInteracting(true);
      setRenderedRecipe(undefined);
      patchSelected({ [axis]: value });
      if (whiteBalanceSettleTimer.current !== undefined) {
        window.clearTimeout(whiteBalanceSettleTimer.current);
      }
      whiteBalanceSettleTimer.current = window.setTimeout(() => {
        whiteBalanceSettleTimer.current = undefined;
        setWhiteBalanceInteracting(false);
      }, EXPOSURE_SETTLE_DELAY_MS);
    },
    [patchSelected],
  );

  const finishWhiteBalanceGesture = useCallback(() => {
    if (whiteBalanceSettleTimer.current !== undefined) {
      window.clearTimeout(whiteBalanceSettleTimer.current);
      whiteBalanceSettleTimer.current = undefined;
    }
    setWhiteBalanceInteracting(false);
  }, []);

  const releasePreview = useCallback(() => {
    decodedFileId.current = undefined;
    settledBaseRecipe.current = undefined;
    clearPreviewCache(previewCache.current);
    lookThumbCache.current.clear();
    setRenderedRecipe(undefined);
    setPreview(undefined);
    setCameraPreview(undefined);
    void client.clear().catch((error: Error) => setGlobalError(error.message));
  }, [client]);

  useEffect(() => {
    let active = true;
    fetch(`${import.meta.env.BASE_URL}luts/manifest.json`, {
      cache: "no-cache",
    })
      .then((response) => {
        if (!response.ok)
          throw new Error("The built-in LUT manifest could not be loaded.");
        return response.json() as Promise<LutManifest>;
      })
      .then(async (value) => {
        if (!Array.isArray(value.luts) || value.luts.length === 0) {
          throw new Error("The built-in LUT manifest is empty.");
        }
        await client.prepareLuts(value.luts);
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
    return client.onThumbnail(({ fileId, jpeg, width, height }) => {
      performance.mark("lutify:thumbnail");
      const filmstripUrl = URL.createObjectURL(
        new Blob([jpeg], { type: "image/jpeg" }),
      );
      const previousUrl = filmstripThumbUrls.current.get(fileId);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      filmstripThumbUrls.current.set(fileId, filmstripUrl);
      updateItem(fileId, {
        thumbUrl: filmstripUrl,
        thumbnailAspect: thumbnailAspectRatio(width, height),
      });
      if (fileId === activeId) {
        const previewUrl = URL.createObjectURL(
          new Blob([jpeg], { type: "image/jpeg" }),
        );
        setCameraPreview({ fileId, url: previewUrl });
      }
    });
  }, [activeId, client, updateItem]);

  useEffect(
    () => () => {
      for (const url of filmstripThumbUrls.current.values()) {
        URL.revokeObjectURL(url);
      }
      filmstripThumbUrls.current.clear();
    },
    [],
  );

  useEffect(() => {
    return client.onPreviewFrame((result) => {
      if (result.fileId !== activeId) return;
      setPreview((current) => mergePreview(current, result));
      setCameraPreview(undefined);
    });
  }, [client, activeId]);

  useEffect(() => {
    return client.onLookPreview((result) => {
      if (
        result.fileId !== activeId ||
        result.ev !== ev ||
        result.whiteBalance.temperature !== temperature ||
        result.whiteBalance.tint !== tint ||
        decodedFileId.current !== result.fileId
      )
        return;
      const cached = lookThumbCache.current.get(result.fileId);
      const rendered =
        cached?.recipe ===
        basePreviewRecipeKey(
          result.fileId,
          result.ev,
          result.whiteBalance.temperature,
          result.whiteBalance.tint,
        )
          ? new Map(cached.images)
          : new Map();
      const image = {
        bitmap: result.bitmap,
        width: result.width,
        height: result.height,
      };
      rendered.set(result.lutId, image);
      rememberCacheEntry(lookThumbCache.current, result.fileId, {
        recipe: basePreviewRecipeKey(
          result.fileId,
          result.ev,
          result.whiteBalance.temperature,
          result.whiteBalance.tint,
        ),
        images: rendered,
      });
      startTransition(() => {
        setThumbs((current) => {
          const displayed = new Map(current);
          displayed.set(result.lutId, image);
          return displayed;
        });
      });
    });
  }, [client, activeId, ev, temperature, tint]);

  useEffect(
    () => () => {
      if (cameraPreview) URL.revokeObjectURL(cameraPreview.url);
    },
    [cameraPreview],
  );

  // Activate a retained photo source when possible. A cache hit restores the
  // exact last frame synchronously and never enters the decoding state; a miss
  // performs the normal RAW decode and repopulates both bounded caches.
  useEffect(() => {
    if (!active || !activeLut) return;
    let running = true;
    const decodeRecipe = previewRecipeKey(
      active.id,
      ev,
      temperature,
      tint,
      activeLut.id,
    );
    const cachedDisplay = previewCache.current.get(active.id);
    if (cachedDisplay) {
      rememberPreviewCacheEntry(previewCache.current, active.id, cachedDisplay);
    }
    decodedFileId.current = undefined;
    settledBaseRecipe.current = undefined;
    desiredPreview.current = undefined;
    if (cachedDisplay?.recipe === decodeRecipe) {
      setRenderedRecipe(decodeRecipe);
      setPreview(cachedDisplay.preview);
    } else {
      setRenderedRecipe(undefined);
      setPreview(cachedDisplay?.preview);
    }
    setCameraPreview(undefined);
    setGlobalError(undefined);
    setUnsupportedRaw(undefined);

    const publish = (result: DisplayPreviewResult) => {
      const displayed = mergePreview(undefined, result);
      rememberPreviewCacheEntry(previewCache.current, active.id, {
        recipe: decodeRecipe,
        preview: displayed,
      });
      decodedFileId.current = active.id;
      settledBaseRecipe.current = basePreviewRecipeKey(
        active.id,
        ev,
        temperature,
        tint,
      );
      if (pendingExposure.current === ev)
        exposureHasPendingRecipe.current = false;
      setRenderedRecipe(decodeRecipe);
      setPreview(displayed);
      setCameraPreview(undefined);
      setSourceTick((tick) => tick + 1);
      updateItem(active.id, {
        status: "ready",
        baseEv: result.baseEv,
        camera: result.metadata.camera || "Unknown camera",
        dimensions: `${result.metadata.width} × ${result.metadata.height}`,
        thumbnailAspect: thumbnailAspectRatio(
          result.metadata.width,
          result.metadata.height,
        ),
      });
    };

    const decode = async () => {
      updateItem(active.id, { status: "decoding", error: undefined });
      const fileReadStartedAt = performance.now();
      const buffer = await active.file.arrayBuffer();
      performance.mark("lutify:file-read", {
        detail: { durationMs: performance.now() - fileReadStartedAt },
      });
      return client.decode(active.id, buffer, ev, whiteBalance, activeLut);
    };

    const prepare = async () => {
      const retained =
        active.status !== "queued" && (await client.activate(active.id));
      if (!running) return;
      if (!retained) {
        const result = await decode();
        if (running) publish(result);
        return;
      }

      decodedFileId.current = active.id;
      setSourceTick((tick) => tick + 1);
      if (cachedDisplay?.recipe === decodeRecipe) {
        settledBaseRecipe.current = basePreviewRecipeKey(
          active.id,
          ev,
          temperature,
          tint,
        );
        return;
      }
      const result = await client.render(
        active.id,
        ev,
        whiteBalance,
        activeLut,
        {
          maxEdge: SETTLED_PREVIEW_MAX_EDGE,
          includeBase: true,
        },
      );
      if (!("lut" in result)) {
        throw new Error("The settled Preview returned an interaction bitmap.");
      }
      if (running) publish(result);
    };

    void prepare().catch((error: unknown) => {
      if (!running) return;
      const unsupportedFormat = getUnsupportedRawFormat(error);
      if (unsupportedFormat) {
        const message =
          "This RAW uses a compression format LUTify cannot decode.";
        updateItem(active.id, { status: "decode-error", error: message });
        setGlobalError(undefined);
        setUnsupportedRaw(unsupportedFormat);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateItem(active.id, { status: "decode-error", error: message });
      setGlobalError(message);
    });
    return () => {
      running = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, active?.id, Boolean(activeLut), updateItem]);

  // Once the selected photo is usable, load each remaining RAW's embedded
  // camera thumbnail in queue order. This gives the filmstrip visual context
  // without changing selection or paying for a full processed Preview decode.
  useEffect(() => {
    if (!active || !hasUsablePreview(active) || exporting) return;
    if (filmstripThumbBusy.current) return;
    const next = items.find(
      (item) =>
        item.id !== active.id &&
        !item.thumbUrl &&
        !attemptedFilmstripThumbs.current.has(item.id),
    );
    if (!next) return;
    attemptedFilmstripThumbs.current.add(next.id);
    filmstripThumbBusy.current = true;
    void next.file
      .arrayBuffer()
      .then((buffer) => client.loadThumbnail(next.id, buffer))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setGlobalError(
          `The filmstrip thumbnail for ${next.file.name} could not be loaded. ${message}`,
        );
      })
      .finally(() => {
        filmstripThumbBusy.current = false;
        setFilmstripThumbTick((tick) => tick + 1);
      });
  }, [active, client, exporting, filmstripThumbTick, items]);

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
    const recipe = previewRecipeKey(
      active.id,
      ev,
      temperature,
      tint,
      activeLut.id,
    );
    if (renderedRecipe === recipe) return;
    const generation = ++nextPreviewGeneration.current;
    desiredPreview.current = {
      generation,
      fileId: active.id,
      lutId: activeLut.id,
    };
    const baseRecipe = basePreviewRecipeKey(active.id, ev, temperature, tint);
    const includeBase = settledBaseRecipe.current !== baseRecipe;
    const lookInteracting = interactionLookRecipe === recipe;
    const maxEdge =
      exposureInteracting || whiteBalanceInteracting || lookInteracting
        ? INTERACTION_PREVIEW_MAX_EDGE
        : SETTLED_PREVIEW_MAX_EDGE;
    const settlesRecipe = maxEdge === SETTLED_PREVIEW_MAX_EDGE;
    let running = true;
    const render = async () => {
      previewRendersInFlight.current += 1;
      exposureRenderBusy.current = true;
      try {
        const frame = await client.render(
          active.id,
          ev,
          whiteBalance,
          activeLut,
          {
            maxEdge,
            includeBase,
          },
        );
        const desired = desiredPreview.current;
        if (
          desired?.fileId === active.id &&
          desired.lutId === activeLut.id &&
          generation > lastPaintedGeneration.current
        ) {
          lastPaintedGeneration.current = generation;
          setPreview((current) => {
            const displayed = mergePreview(current, frame);
            if (settlesRecipe) {
              rememberPreviewCacheEntry(previewCache.current, active.id, {
                recipe,
                preview: displayed,
              });
            }
            return displayed;
          });
        }
        if (!running) return;
        if (!settlesRecipe) {
          if (lookInteracting) {
            setInteractionLookRecipe((current) =>
              current === recipe ? undefined : current,
            );
          }
          return;
        }
        if (pendingExposure.current !== ev) return;
        settledBaseRecipe.current = baseRecipe;
        exposureHasPendingRecipe.current = false;
        setRenderedRecipe(recipe);
      } catch (error) {
        if (running)
          setGlobalError(
            error instanceof Error ? error.message : String(error),
          );
      } finally {
        previewRendersInFlight.current -= 1;
        exposureRenderBusy.current = previewRendersInFlight.current > 0;
        if (!exposureRenderBusy.current && pendingExposure.current !== ev) {
          schedulePendingExposureRender();
        }
      }
    };
    void render();
    return () => {
      running = false;
      if (desiredPreview.current?.generation === generation)
        desiredPreview.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    client,
    ev,
    temperature,
    tint,
    renderedRecipe,
    active?.id,
    active?.status,
    activeLut?.id,
    sourceTick,
    exposureInteracting,
    whiteBalanceInteracting,
    interactionLookRecipe,
    schedulePendingExposureRender,
  ]);

  // Render every Look in one interruptible Worker batch. Each completed tile
  // is published immediately; main Preview commands still preempt the batch
  // between LUTs, so thumbnail work never delays an EV interaction by more
  // than one 132px render.
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
    const renderedThumbs = lookThumbCache.current.get(active.id);
    const completed =
      renderedThumbs?.recipe ===
      basePreviewRecipeKey(active.id, ev, temperature, tint)
        ? renderedThumbs.images
        : new Map<string, LookThumbImage>();
    if (completed.size === manifest.luts.length) return;
    const fileId = active.id;
    const recipe = basePreviewRecipeKey(fileId, ev, temperature, tint);
    if (failedThumbRecipe.current === recipe) return;
    const missingLuts = manifest.luts.filter(({ id }) => !completed.has(id));
    const luts = [
      ...missingLuts.filter(({ id }) => id === activeLut.id),
      ...missingLuts.filter(({ id }) => id !== activeLut.id),
    ];
    thumbBusy.current = true;
    void client
      .renderLooks(fileId, ev, whiteBalance, luts, THUMB_MAX_EDGE)
      .catch(() => {
        failedThumbRecipe.current = recipe;
      })
      .finally(() => {
        thumbBusy.current = false;
        setThumbBatchTick((tick) => tick + 1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    client,
    manifest,
    active,
    activeLut,
    ev,
    temperature,
    tint,
    exporting,
    isPreviewProcessing,
    thumbs,
    thumbBatchTick,
  ]);

  // Build a filmstrip thumbnail once the active photo's base preview lands.
  useEffect(() => {
    if (
      !active ||
      active.thumbUrl ||
      !preview?.base ||
      !("pixels" in preview.base)
    )
      return;
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

  useEffect(() => {
    if (
      temperatureInput.current &&
      document.activeElement !== temperatureInput.current
    ) {
      temperatureInput.current.value = String(temperature);
    }
    if (temperatureRange.current) {
      temperatureRange.current.value = String(temperature);
      temperatureRange.current.setAttribute("aria-valuetext", `${temperature}`);
    }
    if (tintInput.current && document.activeElement !== tintInput.current) {
      tintInput.current.value = String(tint);
    }
    if (tintRange.current) {
      tintRange.current.value = String(tint);
      tintRange.current.setAttribute("aria-valuetext", `${tint}`);
    }
  }, [temperature, tint]);

  useEffect(
    () => () => {
      if (exposureCommitTimer.current !== undefined)
        window.clearTimeout(exposureCommitTimer.current);
      if (exposureSettleTimer.current !== undefined)
        window.clearTimeout(exposureSettleTimer.current);
      if (whiteBalanceSettleTimer.current !== undefined)
        window.clearTimeout(whiteBalanceSettleTimer.current);
    },
    [],
  );

  // ── File intake ──────────────────────────────────────────────────────────
  const addFiles = useCallback(
    (files: File[]) => {
      const existing = new Set(items.map((item) => item.id));
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
          temperature: 0,
          tint: 0,
          lutId: DEFAULT_LUT_ID,
          thumbUrl: filmstripThumbUrls.current.get(id),
        });
      }
      if (additions.length === 0) return;
      performance.mark("lutify:file-selected");
      setGlobalError(undefined);
      setQueueUndo(undefined);
      setExportSummary(undefined);
      setItems([...items, ...additions]);
      setActiveId(additions[0].id);
      setSelectedIds(new Set([additions[0].id]));
    },
    [items],
  );

  const openFilePicker = useCallback(() => fileInput.current?.click(), []);

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

  const removeItem = useCallback(
    (id: string) => {
      const item = items.find((candidate) => candidate.id === id);
      if (!item) return;
      setQueueUndo({
        items: [item],
        activeId: activeId === id ? id : undefined,
        message: `Removed ${item.file.name}`,
      });
      const remaining = items.filter((candidate) => candidate.id !== id);
      const cachedPreview = previewCache.current.get(id);
      if (cachedPreview) releasePreviewBitmaps(cachedPreview.preview);
      previewCache.current.delete(id);
      lookThumbCache.current.delete(id);
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
      }
      if (remaining.length === 0) releasePreview();
      else
        void client
          .release(id)
          .catch((error: Error) => setGlobalError(error.message));
    },
    [activeId, client, items, releasePreview],
  );

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
    const output = OUTPUT_FORMATS[outputFormat];
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
        let image: Uint8Array | undefined;
        try {
          const exported = await client.export(
            item.id,
            await item.file.arrayBuffer(),
            item.ev,
            { temperature: item.temperature, tint: item.tint },
            item.baseEv,
            lut,
            outputFormat,
          );
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
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failed.push(item.file.name);
          updateItem(item.id, {
            status: "export-error",
            error: message,
          });
          setGlobalError(message);
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
          { type: single ? output.mime : "application/zip" },
        );
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = single ? singleOutput!.name : `lutify-${lutId}.zip`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }

      const detail = failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : "";
      setExportSummary(
        stopped
          ? `Stopped after ${outputNames.size} of ${targets.length} ${output.label} exports.${detail}`
          : `Exported ${outputNames.size} of ${targets.length} as ${output.label}.${detail}`,
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
        localStorage.setItem("lutify-panel-w", String(panelWidthRef.current));
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
        localStorage.setItem("lutify-strip-h", String(stripHeightRef.current));
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
  // Refs are the synchronous source of truth for warm presentation caches.
  // Reading them during the active-photo render avoids one stale paint before
  // the restoration effects update their state mirrors.
  const visiblePreview = active
    ? preview?.fileId === active.id
      ? preview
      : previewCache.current.get(active.id)?.preview
    : undefined;
  const visibleThumbs =
    active && displayedThumbFileId.current !== active.id
      ? (lookThumbCache.current.get(active.id)?.images ?? EMPTY_LOOK_THUMBS)
      : thumbs;
  const showCompare = Boolean(active && activeLut && !isDecodeFailure(active));
  const showCamera = Boolean(
    !visiblePreview &&
      cameraPreview &&
      active &&
      cameraPreview.fileId === active.id,
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
          <h1 className="brand__name">LUTify</h1>
        </div>
        <div
          className="header__doc"
          aria-label="Current document"
          aria-live="polite"
        >
          {active ? (
            <>
              <span className="header__name">{active.file.name}</span>
              {active.camera && (
                <span className="header__camera">{active.camera}</span>
              )}
              {active.dimensions && (
                <span className="header__dims" aria-label="Photo dimensions">
                  {active.dimensions}
                </span>
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
          {active && manifest?.contract.outputStatus === "unverified" && (
            <span
              className="header__warning"
              aria-label="Unverified output color space. Check the exported file before production use."
              title="Built-in looks do not declare an output color space. Check the exported file before production use."
            >
              <TriangleAlert size={13} aria-hidden="true" />
              <span>Unverified output</span>
            </span>
          )}
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
          data-decode-count={visiblePreview?.decodeCount}
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
                curated look, then export a 16-bit TIFF or Quality 95 JPEG.
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
                base={visiblePreview?.base}
                look={visiblePreview?.lut}
                lookLabel={activeLut.name}
                mode={compareMode}
                resetKey={active.id}
                isLoading={active.status === "decoding"}
              />
              {active.status === "decoding" && visiblePreview && (
                <div className="overlay-note" role="status">
                  <LoaderCircle size={16} className="spin" aria-hidden="true" />
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
                    onPointerUp={finishExposureGesture}
                    onPointerCancel={finishExposureGesture}
                    onBlur={finishExposureGesture}
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

              <div className="panel panel--white-balance">
                <div className="panel__head">
                  <div className="panel__heading">
                    <span className="panel__title">White Balance</span>
                    <span className="panel__status">
                      As Shot
                      {selectedIds.size > 1
                        ? ` · ${selectedIds.size} photos${mixedWhiteBalance ? " · mixed" : ""}`
                        : ""}
                    </span>
                  </div>
                  <Button
                    size="icon"
                    variant="quiet"
                    aria-label="Reset white balance"
                    onClick={() => setWhiteBalance({ temperature: 0, tint: 0 })}
                    disabled={
                      exporting ||
                      !active ||
                      (!mixedWhiteBalance && temperature === 0 && tint === 0)
                    }
                  >
                    <RotateCcw size={15} aria-hidden="true" />
                  </Button>
                </div>
                <div className="white-balance">
                  <div className="white-balance__row">
                    <label htmlFor="temperature">Temp</label>
                    <input
                      ref={temperatureRange}
                      id="temperature"
                      className="chromatic-range chromatic-range--temperature"
                      type="range"
                      aria-label="White balance temperature"
                      min="-100"
                      max="100"
                      step="1"
                      defaultValue={temperature}
                      aria-valuetext={`${temperature}`}
                      disabled={exporting || !active}
                      onInput={(event) =>
                        scheduleWhiteBalancePreview(
                          "temperature",
                          event.currentTarget,
                        )
                      }
                      onPointerUp={finishWhiteBalanceGesture}
                      onPointerCancel={finishWhiteBalanceGesture}
                      onBlur={finishWhiteBalanceGesture}
                    />
                    <input
                      ref={temperatureInput}
                      className="white-balance__value"
                      aria-label="White balance temperature value"
                      type="number"
                      min="-100"
                      max="100"
                      step="1"
                      defaultValue={temperature}
                      disabled={exporting || !active}
                      onChange={(event) => {
                        const value = event.currentTarget.valueAsNumber;
                        if (Number.isFinite(value)) {
                          setWhiteBalance({
                            temperature: clamp(value, -100, 100),
                          });
                        }
                      }}
                      onBlur={(event) => {
                        event.currentTarget.value = String(temperature);
                      }}
                    />
                  </div>
                  <div className="white-balance__row">
                    <label htmlFor="tint">Tint</label>
                    <input
                      ref={tintRange}
                      id="tint"
                      className="chromatic-range chromatic-range--tint"
                      type="range"
                      aria-label="White balance tint"
                      min="-100"
                      max="100"
                      step="1"
                      defaultValue={tint}
                      aria-valuetext={`${tint}`}
                      disabled={exporting || !active}
                      onInput={(event) =>
                        scheduleWhiteBalancePreview("tint", event.currentTarget)
                      }
                      onPointerUp={finishWhiteBalanceGesture}
                      onPointerCancel={finishWhiteBalanceGesture}
                      onBlur={finishWhiteBalanceGesture}
                    />
                    <input
                      ref={tintInput}
                      className="white-balance__value"
                      aria-label="White balance tint value"
                      type="number"
                      min="-100"
                      max="100"
                      step="1"
                      defaultValue={tint}
                      disabled={exporting || !active}
                      onChange={(event) => {
                        const value = event.currentTarget.valueAsNumber;
                        if (Number.isFinite(value)) {
                          setWhiteBalance({ tint: clamp(value, -100, 100) });
                        }
                      }}
                      onBlur={(event) => {
                        event.currentTarget.value = String(tint);
                      }}
                    />
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
                    thumbs={visibleThumbs}
                    query={lookQuery}
                    onQuery={setLookQuery}
                    thumbnailAspect={active?.thumbnailAspect}
                    disabled={exporting || !active}
                  />
                ) : (
                  <p className="export-note">
                    {manifestError ?? "Loading built-in looks…"}
                  </p>
                )}
              </div>

              <div className="panel panel--output" aria-label="Output">
                <label className="output-format">
                  <span>Format</span>
                  <select
                    aria-label="Export format"
                    value={outputFormat}
                    disabled={exporting}
                    onChange={(event) =>
                      setOutputFormat(event.currentTarget.value as OutputFormat)
                    }
                  >
                    <option value="tiff">TIFF · 16-bit</option>
                    <option value="jpeg">JPEG · Quality 95</option>
                  </select>
                </label>
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
                      : `${exportProgress.current} / ${exportProgress.total} · Stop after current`}
                  </Button>
                ) : (
                  <Button
                    size="block"
                    variant="primary"
                    aria-label={
                      eligibleSelected.length > 1
                        ? `Export ${eligibleSelected.length} photos as ${OUTPUT_FORMATS[outputFormat].label}`
                        : `Export selected as ${OUTPUT_FORMATS[outputFormat].label}`
                    }
                    onClick={() => void exportSelected()}
                    disabled={!canExport}
                  >
                    {exporting ? (
                      <LoaderCircle
                        size={16}
                        className="spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <ImageDown size={16} aria-hidden="true" />
                    )}
                    {exporting
                      ? "Exporting…"
                      : eligibleSelected.length > 1
                        ? `Export ${eligibleSelected.length} ${OUTPUT_FORMATS[outputFormat].label} files`
                        : `Export ${OUTPUT_FORMATS[outputFormat].label}`}
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
          onAdd={openFilePicker}
        />
      </div>

      {unsupportedRaw && (
        <UnsupportedRawDialog
          format={unsupportedRaw}
          onClose={() => setUnsupportedRaw(undefined)}
        />
      )}

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
        {exportSummary && (
          <div className="toast" role="status">
            <span className="toast__body">{exportSummary}</span>
            <div className="toast__actions">
              <Button
                size="icon"
                variant="quiet"
                aria-label="Dismiss export summary"
                onClick={() => setExportSummary(undefined)}
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
