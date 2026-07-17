import type {
  DemosaicBenchmarkCommand,
  DemosaicBenchmarkReply,
  DemosaicBenchmarkReport,
} from "./demosaic-benchmark-types";

/** Mounts the opt-in browser benchmark without starting the product UI. */
export function mountDemosaicBenchmark(): void {
  const client = new DemosaicBenchmarkClient();
  let referenceRgb16: ArrayBuffer | undefined;
  const referenceInput = document.createElement("input");
  referenceInput.type = "file";
  referenceInput.setAttribute("aria-label", "Demosaic RGB16 reference");
  referenceInput.addEventListener("change", () => {
    const file = referenceInput.files?.[0];
    if (!file) return;
    delete document.body.dataset.benchmarkReference;
    void file.arrayBuffer().then((buffer) => {
      referenceRgb16 = buffer;
      document.body.dataset.benchmarkReference = "ready";
    });
  });
  const input = document.createElement("input");
  input.type = "file";
  input.setAttribute("aria-label", "Demosaic benchmark RAW");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    void file
      .arrayBuffer()
      .then((buffer) => client.benchmark(buffer, referenceRgb16))
      .then((report) => {
        performance.mark("raw-alchemy:demosaic-benchmark", { detail: report });
        document.body.dataset.benchmarkStatus = "complete";
      })
      .catch((error: unknown) => {
        document.body.dataset.benchmarkStatus = "error";
        document.body.dataset.benchmarkError =
          error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        referenceRgb16 = undefined;
        delete document.body.dataset.benchmarkReference;
        referenceInput.value = "";
        input.value = "";
      });
  });
  document.body.replaceChildren(referenceInput, input);
  document.body.dataset.benchmarkStatus = "ready";
}

class DemosaicBenchmarkClient {
  private readonly worker = new Worker(
    new URL("./workers/demosaic-benchmark.worker.ts", import.meta.url),
    { type: "module" },
  );
  private requestId = 0;

  benchmark(
    buffer: ArrayBuffer,
    referenceRgb16?: ArrayBuffer,
  ): Promise<DemosaicBenchmarkReport> {
    const search = new URLSearchParams(location.search);
    const backend =
      search.get("demosaicBackend") === "libraw-aahd-wgsl"
        ? "libraw-aahd-wgsl"
        : "libraw-aahd-wgsl-tiled";
    const contract =
      search.get("demosaicContract") === "deterministic-parallel-candidate"
        ? "deterministic-parallel-candidate"
        : "libraw-parity";
    const requestedStage = search.get("demosaicOutputStage");
    const stages: DemosaicBenchmarkCommand["outputStage"][] = [
      "scaled",
      "corrected",
      "defects",
      "horizontal",
      "vertical",
      "horizontal-yuv",
      "vertical-yuv",
      "horizontal-homogeneity",
      "vertical-homogeneity",
      "chosen-directions",
      "directions",
      "candidate-directions",
      "aahd",
      "highlight",
      "final",
    ];
    const outputStage =
      stages.find((stage) => stage === requestedStage) ?? "final";
    const requestId = ++this.requestId;
    const command: DemosaicBenchmarkCommand = {
      requestId,
      buffer,
      referenceRgb16,
      backend,
      contract,
      outputStage,
      librawReference: search.get("librawReference") === "1",
      candidateReference: search.get("candidateReference") === "1",
    };
    return new Promise((resolve, reject) => {
      this.worker.onmessage = ({
        data,
      }: MessageEvent<DemosaicBenchmarkReply>) => {
        if (data.requestId !== requestId) return;
        if (data.ok) resolve(data.report);
        else reject(new Error(data.error));
      };
      this.worker.onerror = (event) => {
        reject(new Error(event.message || "Demosaic benchmark worker failed."));
      };
      const transfer = referenceRgb16 ? [buffer, referenceRgb16] : [buffer];
      this.worker.postMessage(command, transfer);
    });
  }
}
