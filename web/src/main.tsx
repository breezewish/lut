import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

declare const TEST_ENTRIES_ENABLED: boolean;

const ISOLATION_RELOAD_KEY = "raw-alchemy-cross-origin-isolation-reload";

async function enableCrossOriginIsolation(): Promise<void> {
  if (crossOriginIsolated) {
    sessionStorage.removeItem(ISOLATION_RELOAD_KEY);
    return;
  }
  // Let the product mount on an insecure origin so its existing WebGPU
  // compatibility path can explain why RAW processing is unavailable.
  if (!isSecureContext) return;
  if (!("serviceWorker" in navigator)) {
    throw new Error(
      "RAW Alchemy requires a secure browser context with service workers",
    );
  }

  const controllerChanged = new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => resolve(),
      {
        once: true,
      },
    );
  });
  await navigator.serviceWorker.register(
    `${import.meta.env.BASE_URL}coi-serviceworker.js`,
    {
      scope: import.meta.env.BASE_URL,
      updateViaCache: "none",
    },
  );
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await controllerChanged;

  if (sessionStorage.getItem(ISOLATION_RELOAD_KEY) === "1") {
    throw new Error("The browser could not enable cross-origin isolation");
  }
  sessionStorage.setItem(ISOLATION_RELOAD_KEY, "1");
  location.reload();
  await new Promise<never>(() => undefined);
}

async function mount(): Promise<void> {
  await enableCrossOriginIsolation();
  const search = new URLSearchParams(location.search);
  if (TEST_ENTRIES_ENABLED && search.get("aahdTileBenchmark") === "1") {
    const { mountAahdTileBenchmark } = await import("./aahd-tile-benchmark");
    mountAahdTileBenchmark();
  } else if (TEST_ENTRIES_ENABLED && search.get("xtransParity") === "1") {
    const { mountXtransParity } = await import("./xtrans-parity-benchmark");
    mountXtransParity();
  } else if (TEST_ENTRIES_ENABLED && search.get("previewCorrectness") === "1") {
    const { mountPreviewCorrectness } = await import("./preview-correctness");
    mountPreviewCorrectness();
  } else {
    createRoot(document.getElementById("root")!).render(<App />);
  }
}

void mount().catch((error: unknown) => {
  const alert = document.createElement("p");
  alert.setAttribute("role", "alert");
  alert.textContent = error instanceof Error ? error.message : String(error);
  document.getElementById("root")!.replaceChildren(alert);
});
