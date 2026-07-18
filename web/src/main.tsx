import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

declare const TEST_ENTRIES_ENABLED: boolean;

const search = new URLSearchParams(location.search);
if (TEST_ENTRIES_ENABLED && search.get("aahdTileBenchmark") === "1") {
  void import("./aahd-tile-benchmark").then(({ mountAahdTileBenchmark }) =>
    mountAahdTileBenchmark(),
  );
} else if (TEST_ENTRIES_ENABLED && search.get("previewCorrectness") === "1") {
  void import("./preview-correctness").then(({ mountPreviewCorrectness }) =>
    mountPreviewCorrectness(),
  );
} else {
  createRoot(document.getElementById("root")!).render(<App />);
}
