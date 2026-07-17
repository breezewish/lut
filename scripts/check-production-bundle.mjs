import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const files = await readdir(dist, { recursive: true });
const forbidden = files.filter((file) =>
  /(?:benchmark|onnx|native-rcd|\.onnx$)/i.test(file),
);

if (forbidden.length > 0) {
  throw new Error(
    `Production bundle contains test or abandoned backend assets: ${forbidden.join(", ")}`,
  );
}

const workers = files.filter((file) => /processing\.worker-.*\.js$/.test(file));
if (workers.length !== 1) {
  throw new Error(
    `Expected one production Worker bundle; found ${workers.length}.`,
  );
}
const worker = await readFile(join(dist, workers[0]), "utf8");
const forbiddenWorkerCode = [
  "Tiled AAHD captured",
  "onnxruntime",
  ".onnx",
  "native-rcd",
];
const includedCode = forbiddenWorkerCode.filter((value) =>
  worker.includes(value),
);
if (includedCode.length > 0) {
  throw new Error(
    `Production Worker contains test or abandoned backend code: ${includedCode.join(", ")}`,
  );
}

console.log("Verified production bundle excludes test and abandoned backends.");
