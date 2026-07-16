import { ProcessingClient } from "./lib/processing-client";

/** Mounts the opt-in browser benchmark without starting the product UI. */
export function mountDemosaicBenchmark(): void {
  const client = new ProcessingClient();
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
      .then((buffer) => client.benchmarkDemosaic(buffer, referenceRgb16))
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
