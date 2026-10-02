/**
 * 开发者日志装配（app 层，2026-09-24 任务卡 v2）：
 * core/diagnostics/logger 零依赖自包含，各模块 store 订阅、开关持久化与
 * 启停编排接在这里。
 * - 开关：localStorage（zustand persist，键 ystk-devlog，默认关）
 * - 落盘：dev server 中间件直写仓库根 devdata/logs/（浏览器侧只 POST，
 *   无目录选择、无授权、无句柄存储——用户 2026-09-24 口径）
 * - store 订阅：一次性挂上（订阅回调里判开关，关闭时一个闭包调用即返回，
 *   可忽略不计）；摘要走白名单字段，绝不快照全量 state
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { devLog, devLogStart, devLogState, devLogStop } from "../core/diagnostics/logger";
import { useCanvasStore } from "../modules/canvas/api";
import { useLabStore } from "../modules/lab/api";
import { useLibraryStore } from "../modules/library/api";
import { useSuperResStore } from "../modules/superres/api";
import { useThemeStore } from "./theme";
import { APP_VERSION } from "./version";

interface DevLogSettingsState {
  enabled: boolean;
}

/** 初始态显式标注：否则字面量类型 false 会被推成窄类型，与 setState(boolean) 冲突 */
const INITIAL: DevLogSettingsState = { enabled: false };

export const useDevLogStore = create<DevLogSettingsState>()(
  persist(() => ({ ...INITIAL }), { name: "ystk-devlog" }),
);

/** 会话元信息（每个会话文件第一行内容） */
function writeMeta(): void {
  devLog(
    "meta",
    "meta",
    `YuanShe ToolKit v${APP_VERSION} 开发者日志会话开始`,
    JSON.stringify({
      app: APP_VERSION,
      ua: navigator.userAgent,
      href: location.href,
      screen: `${window.screen.width}x${window.screen.height}`,
      dpr: window.devicePixelRatio,
    }),
  );
}

/* ---- store 订阅（白名单摘要 + 变化才记；去重由 logger.devLogState 做） ---- */

let wired = false;

function attachStoreSubscriptions(): void {
  if (wired) return;
  wired = true;

  useLibraryStore.subscribe((s) => {
    if (!useDevLogStore.getState().enabled) return;
    devLogState("library", {
      phase: s.phase,
      lib: s.current?.name ?? null,
      items: s.items.length,
      scan: s.scan.running
        ? `${s.scan.done}/${s.scan.total}${s.scan.paused ? " 暂停" : ""}`
        : null,
      analysis: s.analysis.running
        ? `${s.analysis.stage} ${s.analysis.done}/${s.analysis.total} 失败${s.analysis.failed}${s.analysis.paused ? " 暂停" : ""}`
        : null,
      vision: s.vision.running
        ? `${s.vision.done}/${s.vision.total} 失败${s.vision.failed}`
        : s.vision.done + s.vision.failed > 0
          ? `收尾 ${s.vision.done}/${s.vision.total} 失败${s.vision.failed}`
          : null,
      visionBlock: s.vision.blockedReason,
      query: s.searchQuery || null,
      selectMode: s.selectMode ? s.selectedIds.size : null,
      detail: s.detailId != null,
      sort: `${s.sortKey}/${s.sortDir}`,
      folder: s.folderScope,
      cross: s.cross.loading ? "检索中" : null,
    });
  });

  useCanvasStore.subscribe((s) => {
    if (!useDevLogStore.getState().enabled) return;
    devLogState("canvas", {
      elements: s.elements.length,
      selected: s.selectedIds.length,
      tool: s.tool,
      editing: s.editingId != null,
      history: s.past.length,
      lastOp: s.past.length > 0 ? (s.past[s.past.length - 1]?.label ?? null) : null,
      savedAt: s.lastSavedAt,
    });
  });

  useLabStore.subscribe((s) => {
    if (!useDevLogStore.getState().enabled) return;
    devLogState("lab", {
      tool: s.tool,
      image: s.image?.name ?? null,
      overlay: s.overlay,
    });
  });

  useSuperResStore.subscribe((s) => {
    if (!useDevLogStore.getState().enabled) return;
    devLogState("superres", {
      mode: s.mode,
      scale: `${s.scale}x`,
      denoise: s.denoise,
      status: s.status,
      phase: s.status === "running" ? s.phase : null,
      backend: s.backend,
      adapter: s.adapter,
      error: s.error,
    });
  });

  useThemeStore.subscribe((s) => {
    if (!useDevLogStore.getState().enabled) return;
    devLogState("theme", { theme: s.theme });
  });
}

/* ---- 启停编排 ---- */

/** 开启（幂等）：main.tsx 渲染前与设置行开关打开沿共用 */
export function enableDevLog(): void {
  devLogStart();
  writeMeta();
  attachStoreSubscriptions();
}

/** main.tsx 渲染前调用：开关已开则立即恢复采集（早于 React，捕获启动期异常） */
export function initDevLog(): void {
  if (!useDevLogStore.getState().enabled) return;
  enableDevLog();
}

/** 设置行开关关闭沿：先落完最后一批再停（内部含最终上报） */
export async function disableDevLog(): Promise<void> {
  await devLogStop();
}
