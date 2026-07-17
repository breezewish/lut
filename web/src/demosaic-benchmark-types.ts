import type { LibRawAahdResult } from "./lib/libraw-aahd";
import type { SensorImageInfo } from "./lib/sensor-image";
import type { LibRawSensorTimings } from "./types";

export interface DemosaicBenchmarkCommand {
  requestId: number;
  buffer: ArrayBuffer;
  referenceRgb16?: ArrayBuffer;
  backend: "libraw-aahd-wgsl" | "libraw-aahd-wgsl-tiled";
  contract: "deterministic-parallel-candidate" | "libraw-parity";
  outputStage: Exclude<LibRawAahdResult["outputStage"], "graded-final">;
  librawReference: boolean;
  candidateReference: boolean;
}

export interface DemosaicBenchmarkReport {
  sensor: SensorImageInfo;
  sensorTimings: LibRawSensorTimings;
  demosaic: LibRawAahdResult;
  workerTotalMs: number;
}

export type DemosaicBenchmarkReply =
  | { requestId: number; ok: true; report: DemosaicBenchmarkReport }
  | { requestId: number; ok: false; error: string };
