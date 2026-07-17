import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

const search = new URLSearchParams(location.search);
if (search.get("aahdTileBenchmark") === "1") {
  void import("./aahd-tile-benchmark").then(({ mountAahdTileBenchmark }) =>
    mountAahdTileBenchmark(),
  );
} else if (search.get("demosaicBenchmark") === "1") {
  void import("./demosaic-benchmark").then(({ mountDemosaicBenchmark }) =>
    mountDemosaicBenchmark(),
  );
} else {
  createRoot(document.getElementById("root")!).render(<App />);
}
