import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles.css";

if (new URLSearchParams(location.search).get("demosaicBenchmark") === "1") {
  void import("./demosaic-benchmark").then(({ mountDemosaicBenchmark }) =>
    mountDemosaicBenchmark(),
  );
} else {
  createRoot(document.getElementById("root")!).render(<App />);
}
