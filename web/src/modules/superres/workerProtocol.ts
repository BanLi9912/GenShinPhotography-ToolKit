/** 超分推理 Worker 消息协议（主线程 ↔ superres.worker.ts） */

export type SuperResWorkerRequest =
  /** model：模型文件完整基名（如 up3x-latest-denoise3x） */
  | { type: "init"; model: string; preferWebgpu: boolean }
  /** w/h：tile 输入宽高（动态模型 400；upscalejs 2x 固定输入由引擎保证喂 200） */
  | { type: "run"; id: number; buffer: ArrayBuffer; w: number; h: number };

export type SuperResWorkerResponse =
  | { type: "ready"; backend: "webgpu" | "wasm" }
  /** outW/outH 取自输出张量 dims[2]/dims[3]（输出尺寸以模型为准，引擎不猜倍率） */
  | { type: "tile"; id: number; buffer: ArrayBuffer; outW: number; outH: number }
  | { type: "error"; id?: number; message: string };
