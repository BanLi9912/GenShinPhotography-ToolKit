import * as ort from "onnxruntime-web";
import type {
  SuperResWorkerRequest,
  SuperResWorkerResponse,
} from "./workerProtocol";

/** 资产根路径（public/superres-assets，由 predev/prebuild 复制） */
const ASSET_BASE = "/superres-assets/";

ort.env.wasm.wasmPaths = `${ASSET_BASE}js/`;

/**
 * 读取适配器名（worker 自报**实际推理用卡**，PR-008 诊断项 / 2026-10-02）。
 *
 * 优先问 ORT 自己建 WebGPU EP 时用的那个 adapter（session 建好后即可读，最可信——
 * 「自报的卡」与「推理用的卡」是同一张，不靠偏好推断）；拿不到再按同偏好另请一次。
 * `adapter.info` 是新 API（新版 Chromium），`requestAdapterInfo()` 已废弃、仅作兜底；
 * 都拿不到就返回空串——空串不影响推理，只影响进度区显示。
 */
async function readAdapterName(): Promise<string> {
  const nameOf = (info?: {
    description?: string;
    device?: string;
    vendor?: string;
  }): string => (info ? info.description || info.device || info.vendor || "" : "");
  const fromAdapter = async (adapter: unknown): Promise<string> => {
    if (!adapter) return "";
    const a = adapter as {
      info?: { description?: string; device?: string; vendor?: string };
      requestAdapterInfo?: () => Promise<{
        description?: string;
        device?: string;
        vendor?: string;
      }>;
    };
    if (a.info) return nameOf(a.info);
    if (typeof a.requestAdapterInfo === "function") {
      try {
        return nameOf(await a.requestAdapterInfo());
      } catch {
        /* 部分环境不暴露适配器信息，忽略 */
      }
    }
    return "";
  };

  try {
    const used = await fromAdapter(ort.env.webgpu.adapter);
    if (used) return used;
  } catch {
    /* ORT 未暴露 adapter 时走下面的兜底 */
  }
  try {
    const gpu = (
      navigator as Navigator & {
        gpu?: {
          requestAdapter?: (options?: {
            powerPreference?: "high-performance" | "low-power";
          }) => Promise<unknown>;
        };
      }
    ).gpu;
    if (!gpu?.requestAdapter) return "";
    // 与 EP 内部请求同偏好，正常返回同一张卡（枚举级请求本身轻量）
    return await fromAdapter(
      await gpu.requestAdapter({
        powerPreference: ort.env.webgpu.powerPreference ?? "low-power",
      }),
    );
  } catch {
    return "";
  }
}

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
      // 防崩口径（PR-008/2026-10-02）：适配器偏好由主线程按推理设备档传入，缺省核显优先——
      // 不再在模块顶层硬编码 "high-performance"（请求独显正是 N 卡 WebGPU 崩溃的风险源）。
      ort.env.webgpu.powerPreference = msg.powerPreference ?? "low-power";
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
        adapterName: msg.preferWebgpu ? await readAdapterName() : "",
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
