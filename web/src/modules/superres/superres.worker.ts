import * as ort from "onnxruntime-web";
import type {
  SuperResWorkerRequest,
  SuperResWorkerResponse,
} from "./workerProtocol";

/** 资产根路径（public/superres-assets，由 predev/prebuild 复制） */
const ASSET_BASE = "/superres-assets/";

ort.env.wasm.wasmPaths = `${ASSET_BASE}js/`;

// 双显卡笔记本默认 adapter 是核显；ORT 建 WebGPU EP 时按此偏好请求独显（dGPU）。
ort.env.webgpu.powerPreference = "high-performance";

/**
 * 每个 Worker 拥有独立的 ORT 模块上下文：
 * WebGPU 初始化失败不会污染 WASM 初始化状态，
 * 主线程可用全新 Worker 干净回退到 CPU。
 */
const workerScope = self as unknown as {
  onmessage: ((e: MessageEvent<SuperResWorkerRequest>) => void) | null;
  postMessage: (msg: SuperResWorkerResponse, transfer?: Transferable[]) => void;
};

let session: ort.InferenceSession | null = null;
let inName = "";
let outName = "";

workerScope.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      const url = `${ASSET_BASE}models/${msg.model}.onnx`;
      session = await ort.InferenceSession.create(url, {
        executionProviders: msg.preferWebgpu ? ["webgpu"] : ["wasm"],
        graphOptimizationLevel: "all",
      });
      inName = session.inputNames[0] ?? "";
      outName = session.outputNames[0] ?? "";
      if (!inName || !outName) throw new Error("模型输入/输出不完整");
      workerScope.postMessage({
        type: "ready",
        backend: msg.preferWebgpu ? "webgpu" : "wasm",
      });
    } catch (error) {
      workerScope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "模型加载失败",
      });
    }
    return;
  }

  if (msg.type === "run") {
    try {
      if (!session) throw new Error("模型尚未加载");
      // 输入张量尺寸随消息携带（动态模型 tile 400；upscalejs 2x 固定输入模型
      // 由引擎保证永远喂 200×200，故不在此硬编码）。
      const input = new Float32Array(msg.buffer);
      const tensor = new ort.Tensor("float32", input, [1, 3, msg.h, msg.w]);
      const result = await session.run({ [inName]: tensor });
      const output = result[outName] as ort.Tensor;
      const data = output.data as Float32Array;
      const dims = output.dims as number[];
      const copy = new Float32Array(data);
      // 输出尺寸以模型输出张量为准（2x→400×400，3x→600×600，4x→800×800）
      const outW = dims[2] ?? 0;
      const outH = dims[3] ?? 0;
      workerScope.postMessage(
        {
          type: "tile",
          id: msg.id,
          buffer: copy.buffer,
          outW,
          outH,
        },
        [copy.buffer],
      );
    } catch (error) {
      workerScope.postMessage({
        type: "error",
        id: msg.id,
        message: error instanceof Error ? error.message : "推理失败",
      });
    }
  }
};
