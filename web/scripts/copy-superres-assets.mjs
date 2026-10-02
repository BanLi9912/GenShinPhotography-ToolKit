/**
 * 同步 Real-CUGAN / Kim2091 ONNX 模型与 onnxruntime-web 运行时到 public/superres-assets。
 * 来源：node_modules/upscalejs（2x 五档）+ web/sr-models（SR.0 转换产物）。
 * 增量同步：目标已存在且与源 size 一致 → 跳过（不重写），只复制新增/变更；并清孤儿。
 * 由 npm predev / prebuild 自动执行，资产不入库（见 web/.gitignore）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 本文件位于 web/scripts/，仓库根 = 上级 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ortRoot = resolve(root, "node_modules/onnxruntime-web/dist");
const modelRoot = resolve(root, "node_modules/upscalejs/dist/models");
const srModelsRoot = resolve(root, "sr-models");
const destRoot = resolve(root, "public/superres-assets");

/** onnxruntime-web 1.27：API 模块（extern-wasm 构建）+ WASM 主执行文件 + WebGPU(JSEP) 执行文件 */
const ORT_FILES = [
  "ort.min.mjs",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

/** Real-CUGAN 2x 全部五档（upscalejs 内置官方转换产物） */
const MODEL_FILES = [
  "up2x-latest-no-denoise.onnx",
  "up2x-latest-denoise1x.onnx",
  "up2x-latest-denoise2x.onnx",
  "up2x-latest-denoise3x.onnx",
  "up2x-latest-conservative.onnx",
];

/**
 * 增量复制：目标已存在且与源 size 一致 → 跳过（返回 false）；否则 cpSync 复制（返回 true）。
 */
function copyIfStale(src, dest) {
  if (
    existsSync(dest) &&
    existsSync(src) &&
    statSync(dest).size === statSync(src).size
  ) {
    return false;
  }
  cpSync(src, dest);
  return true;
}

let copied = 0;
let skipped = 0;

mkdirSync(resolve(destRoot, "js"), { recursive: true });
mkdirSync(resolve(destRoot, "models"), { recursive: true });

for (const file of ORT_FILES) {
  if (copyIfStale(resolve(ortRoot, file), resolve(destRoot, "js", file))) copied += 1;
  else skipped += 1;
}
for (const file of MODEL_FILES) {
  if (copyIfStale(resolve(modelRoot, file), resolve(destRoot, "models", file))) copied += 1;
  else skipped += 1;
}

// SR.0 转换产物：web/sr-models/*.onnx（3x/4x 档位、AnimeSharpV4、SuperScale）
const expected = new Set(MODEL_FILES);
if (existsSync(srModelsRoot)) {
  for (const file of readdirSync(srModelsRoot)) {
    if (!file.endsWith(".onnx")) continue;
    expected.add(file);
    if (copyIfStale(resolve(srModelsRoot, file), resolve(destRoot, "models", file))) {
      copied += 1;
    } else {
      skipped += 1;
    }
  }
}

// 清孤儿：destRoot/models 里不在"应存在集合"（MODEL_FILES ∪ sr-models 的 .onnx）中的文件删除，
// 防止以后删模型时在 public 残留。
let cleaned = 0;
const modelsDir = resolve(destRoot, "models");
if (existsSync(modelsDir)) {
  for (const file of readdirSync(modelsDir)) {
    if (!expected.has(file)) {
      rmSync(resolve(modelsDir, file), { force: true });
      cleaned += 1;
    }
  }
}

console.log(
  `[superres] 资产已同步（复制 ${copied} / 跳过 ${skipped} / 清理 ${cleaned}）→ public/superres-assets`,
);
