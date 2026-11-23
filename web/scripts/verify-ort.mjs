import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ort from "onnxruntime-web";

const modelPath = resolve(
  "public/superres-assets/models/up2x-latest-conservative.onnx",
);
const model = new Uint8Array(readFileSync(modelPath));
const session = await ort.InferenceSession.create(model, {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});

console.log("inputs:", session.inputNames);
console.log("outputs:", session.outputNames);

const size = 200;
const input = new Float32Array(3 * size * size).fill(0.5);
const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, size, size]) };
const t0 = Date.now();
const result = await session.run(feeds);
const elapsed = Date.now() - t0;
const output = result[session.outputNames[0]];
console.log("output dims:", output.dims);
console.log("elapsed ms:", elapsed);
