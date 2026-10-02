import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 超分放大倍率：Real-CUGAN 支持 2x/3x/4x */
export type CuganScale = 2 | 3 | 4;

/** 降噪档位：2x 四档（无降噪/1x/2x/3x），3x/4x 三档（无降噪/保守/3x） */
export type DenoiseLevel = "none" | "d1" | "d2" | "d3" | "conservative";

/** 推理后端：优先 WebGPU（GPU），失败回退 WASM（CPU） */
export type SuperResBackend = "webgpu" | "wasm";

/** 处理模式：超分线（Real-CUGAN 放大）/ 纹理保全线（SuperScale→AnimeSharpV4 降噪锐化） */
export type SuperResMode = "cugan" | "texture";

/**
 * 推理设备档（PR-008/2026-10-02 防崩）：
 * - `gpu`：WebGPU，适配器按 `low-power` 请求（核显优先，绕开部分独显驱动的 WebGPU 崩溃）；
 * - `cpu`：仅 WASM，完全不建 WebGPU（任何机器上都不可能触发 WebGPU 崩溃，代价是慢数倍）。
 */
export type SuperResDeviceMode = "gpu" | "cpu";

export interface DenoiseOption {
  id: DenoiseLevel;
  name: string;
  desc: string;
}

/**
 * 各倍率的降噪档位表（用户四档口径）。
 * 2x 提供无降噪/1x/2x/3x 四档；3x/4x 按官方权重实际 = 无降噪/保守/3x。
 * 2x 的 conservative 权重保留在资产里但不接 UI。
 */
export const DENOISE_OPTIONS: Record<CuganScale, DenoiseOption[]> = {
  2: [
    { id: "none", name: "无降噪", desc: "只放大" },
    { id: "d1", name: "1x 降噪", desc: "轻度降噪" },
    { id: "d2", name: "2x 降噪", desc: "细节平衡" },
    { id: "d3", name: "3x 降噪", desc: "强降噪" },
  ],
  3: [
    { id: "none", name: "无降噪", desc: "只放大" },
    { id: "conservative", name: "保守", desc: "保守修复" },
    { id: "d3", name: "3x 降噪", desc: "强降噪" },
  ],
  4: [
    { id: "none", name: "无降噪", desc: "只放大" },
    { id: "conservative", name: "保守", desc: "保守修复" },
    { id: "d3", name: "3x 降噪", desc: "强降噪" },
  ],
};

export interface SuperResImage {
  name: string;
  width: number;
  height: number;
  url: string;
}

export type SuperResStatus = "idle" | "running" | "done" | "error";

function revoke(url: string | null | undefined): void {
  if (url) URL.revokeObjectURL(url);
}

interface SuperResState {
  image: SuperResImage | null;
  /** 处理模式：cugan（超分）/ texture（纹理保全） */
  mode: SuperResMode;
  /** 放大倍率（2x/3x/4x） */
  scale: CuganScale;
  denoise: DenoiseLevel;
  /** 纹理保全线：处理后是否压缩回原分辨率（降噪锐化用途），默认开；超分线不参与 */
  restoreOriginalSize: boolean;
  /** SR.2.2 超分线抗锯齿前置开关：先用 1x-SuperScale 抗锯齿修复一遍再进 CUGAN 超分 */
  antialias: boolean;
  /** 推理设备档（PR-008 防崩）：gpu = WebGPU 核显优先（默认）；cpu = 仅 WASM。**跨会话持久化** */
  deviceMode: SuperResDeviceMode;
  status: SuperResStatus;
  /** 0–100 进度 */
  progress: number;
  /** 当前阶段文案（加载模型/分块推理/合成输出…） */
  phase: string;
  /** 实际使用的推理后端（WebGPU / WASM） */
  backend: SuperResBackend | null;
  /** WebGPU 实际适配器名称（如 NVIDIA …；仅 WebGPU 后端时有） */
  adapter: string;
  result: SuperResImage | null;
  error: string | null;
  setImage: (image: SuperResImage | null) => void;
  setMode: (mode: SuperResMode) => void;
  setScale: (scale: CuganScale) => void;
  setDenoise: (denoise: DenoiseLevel) => void;
  setRestoreOriginalSize: (restore: boolean) => void;
  setAntialias: (antialias: boolean) => void;
  setDeviceMode: (mode: SuperResDeviceMode) => void;
  setRunning: () => void;
  setProgress: (
    progress: number,
    phase: string,
    backend: SuperResBackend | null,
    adapter?: string,
  ) => void;
  setIdle: () => void;
  setResult: (result: SuperResImage | null) => void;
  setError: (error: string | null) => void;
}

/**
 * 超分 store：**只持久化 deviceMode**（PR-008 防崩口径——防崩设置不能在刷新后丢），
 * 其余状态保持"刷新即重置"的现状口径（persist + partialize 先例：`modules/canvas/store.ts`）。
 */
export const useSuperResStore = create<SuperResState>()(
  persist(
    (set) => ({
      image: null,
      mode: "cugan",
      scale: 2,
      denoise: "none",
      restoreOriginalSize: false,
      antialias: false,
      deviceMode: "gpu",
      status: "idle",
      progress: 0,
      phase: "等待开始",
      backend: null,
      adapter: "",
      result: null,
      error: null,
      setImage: (image) =>
        set((s) => {
          revoke(s.image?.url);
          revoke(s.result?.url);
          return {
            image,
            result: null,
            status: "idle",
            progress: 0,
            phase: "等待开始",
            backend: null,
            adapter: "",
            error: null,
          };
        }),
      setMode: (mode) =>
        set(() => ({
          mode,
          // 各模式自然默认：超分线不压缩（放大出图），纹理保全线压缩（降噪锐化），切模式即重置
          restoreOriginalSize: mode === "texture",
          // 切换模式不清除超分结果（保留结果卡供对比）；仅清瞬态错误
          error: null,
        })),
      setScale: (scale) =>
        set((s) => {
          // 切倍率时若当前降噪档不在新倍率档位内，自动回落「无降噪」
          const denoise = DENOISE_OPTIONS[scale].some((o) => o.id === s.denoise)
            ? s.denoise
            : "none";
          revoke(s.result?.url);
          return {
            scale,
            denoise,
            result: null,
            status: "idle",
            progress: 0,
            phase: "等待开始",
            backend: null,
            adapter: "",
            error: null,
          };
        }),
      setDenoise: (denoise) =>
        set((s) => {
          revoke(s.result?.url);
          return {
            denoise,
            result: null,
            status: "idle",
            progress: 0,
            phase: "等待开始",
            backend: null,
            adapter: "",
            error: null,
          };
        }),
      setRestoreOriginalSize: (restoreOriginalSize) =>
        set((s) => {
          revoke(s.result?.url);
          return {
            restoreOriginalSize,
            result: null,
            status: "idle",
            progress: 0,
            phase: "等待开始",
            backend: null,
            adapter: "",
            error: null,
          };
        }),
      setAntialias: (antialias) =>
        set((s) => {
          revoke(s.result?.url);
          return {
            antialias,
            result: null,
            status: "idle",
            progress: 0,
            phase: "等待开始",
            backend: null,
            adapter: "",
            error: null,
          };
        }),
      // 设备档不进结果作废清单：换档只影响下次跑在哪个后端，不改像素口径
      setDeviceMode: (deviceMode) => set({ deviceMode }),
      setRunning: () =>
        set({ status: "running", progress: 0, phase: "准备中…", backend: null, adapter: "", error: null }),
      setProgress: (progress, phase, backend, adapter) =>
        set({ progress, phase, backend, adapter: adapter ?? "" }),
      setIdle: () =>
        set({ status: "idle", progress: 0, phase: "等待开始", backend: null, adapter: "", error: null }),
      setResult: (result) =>
        set((s) => {
          revoke(s.result?.url);
          return {
            result,
            status: result ? "done" : "idle",
            progress: result ? 100 : 0,
            phase: result ? "完成" : "等待开始",
            error: null,
          };
        }),
      setError: (error) => set({ error, status: error ? "error" : "idle" }),
    }),
    {
      name: "ystk-superres",
      // 只落盘防崩档位；其余字段保持刷新重置（见上）
      partialize: (s) => ({ deviceMode: s.deviceMode }),
    },
  ),
);
