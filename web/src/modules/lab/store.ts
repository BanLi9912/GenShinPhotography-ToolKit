import { create } from "zustand";

/** 缩放范围（开发文档-M4 §2.5：0.10–4x） */
export const MIN_ZOOM = 0.10;
export const MAX_ZOOM = 4;

/**
 * 分析工具（开发文档-M4 §2.2 左栏，分组顺序见 LabToolbar）。
 * histogram 为默认激活（§1 默认即有得看）；compare 为 P1 置灰占位；
 * saturation 的 flyout（检查/热力）随任务 M4.5 接入，骨架期按单工具占位。
 */
export type LabTool =
  | "histogram"
  | "dotgain"
  | "saturation"
  | "falsecolor"
  | "palette"
  | "harmony"
  | "stroke"
  | "compare";

/** 工具栏纵向顺序（面板滚动切换方向依据；与 LabToolbar TOOLS 顺序保持一致） */
export const TOOL_ORDER: LabTool[] = [
  "histogram", "dotgain", "saturation", "falsecolor",
  "palette", "harmony", "stroke", "compare",
];

/** 可覆盖渲染源（开发文档-M4 §2.4）：同一时刻至多一个；falsecolor 随 M4.6 接入 */
export type OverlayTool = "dotgain" | "sat-check" | "sat-heat" | "falsecolor";

/** 覆盖源对应的左栏工具（左栏 accent 角标归属；饱和度组两个覆盖源同属 saturation） */
export const OVERLAY_SOURCE_TOOL: Record<OverlayTool, LabTool> = {
  dotgain: "dotgain",
  "sat-check": "saturation",
  "sat-heat": "saturation",
  falsecolor: "falsecolor",
};

/* ---- 划线取色（开发文档-M4 §4.2） ---- */

/** 划线采样点（图像像素坐标；色彩口径 colorUtils：h 0–360，s/l 0–100，rgb 0–255） */
export interface StrokeSample {
  x: number; y: number;
  r: number; g: number; b: number;
  h: number; s: number; l: number;
  /** 归一化弧长位置 0–1 */
  t: number;
}

export interface StrokeLine {
  id: number;
  /** 自动配色（内容色，见 STROKE_COLORS） */
  color: string;
  visible: boolean;
  /** true = 取样点模式：显示分立采样圆点而非连续折线 */
  asPoints: boolean;
  /** 原始路径点（图像像素坐标） */
  points: { x: number; y: number }[];
  /** 采样结果（重算整体覆盖；points 为空/未采样时为 []） */
  samples: StrokeSample[];
  /** 弧长（图像 px） */
  totalLen: number;
}

/** 划线自动配色（内容色，双主题通用；按 id 循环取色） */
export const STROKE_COLORS = ["#ffd60a", "#0a84ff", "#ff9f0a", "#32d74b", "#ff375f", "#64d2ff"];

/**
 * 已打开图像的元信息。像素本体常驻 imageSource.ts 的离屏 canvas
 * （状态栏读数与后续分析器共用），不进状态、不触发渲染。
 */
export interface LabImage {
  name: string;
  width: number;
  height: number;
  /** 显示用 URL（objectURL 或 dataURL），由 imageSource.ts 生成与回收 */
  url: string;
}

/** 视口：图像在视口内的偏移（屏幕 px）与缩放（1 = 100%） */
export interface LabViewport {
  x: number;
  y: number;
  zoom: number;
}

/** 光标读数（状态栏）：图像像素坐标 + 该像素 RGB/HSL；光标在图外为 null */
export interface LabPointer {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  h: number;
  s: number;
  l: number;
}

/** 输出面板状态（localStorage 持久化，design.md §6"布局状态记忆"） */
export interface LabPanelState {
  width: number;
  collapsed: boolean;
}

/** 面板布局持久化 key 与默认值 */
const PANEL_STORAGE_KEY = "ystk-lab-panel";
const DEFAULT_PANEL: LabPanelState = { width: 420, collapsed: true };

/** 读取持久化的面板状态；缺失/非法/异常一律回退默认。**启动始终收起**，仅保留宽度 */
function loadPanel(): LabPanelState {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return DEFAULT_PANEL;
    const p: unknown = JSON.parse(raw);
    if (
      typeof p === "object" &&
      p !== null &&
      typeof (p as LabPanelState).width === "number" &&
      (p as LabPanelState).width >= 280 &&
      (p as LabPanelState).width <= 720
    )
      return { width: (p as LabPanelState).width, collapsed: true };
    return DEFAULT_PANEL;
  } catch {
    return DEFAULT_PANEL;
  }
}

/** 写回持久化（try/catch：隐私模式等写入失败不写崩） */
function savePanel(panel: LabPanelState): void {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(panel));
  } catch {
    /* 写入失败静默忽略 */
  }
}

interface LabState {
  /** 当前分析工具（右半输出区随其切换） */
  tool: LabTool;
  /** 1 = 新工具在旧工具下方（面板自下方进入），-1 = 上方 */
  toolDir: 1 | -1;
  image: LabImage | null;
  viewport: LabViewport;
  pointer: LabPointer | null;
  /** 输出面板（悬浮于视口之上，可调宽/收起；localStorage 持久化，design.md §6） */
  panel: LabPanelState;
  /** 色阶黑/白场（luma 0–255，null = 未拾取，换图清空） */
  levels: { black: number; white: number } | null;
  /** 拾取模式（null = 未在拾取）；激活时视口 crosshair、点击取色 */
  levelsPick: "black" | "white" | null;
  /** 当前激活的画面覆盖（§2.4：同一时刻至多一个，单字段天然互斥）；null = 原图 */
  overlay: OverlayTool | null;
  /** 饱和度组当前子工具（flyout 两项；面板标题/开关/覆盖源随之切换） */
  satMode: "check" | "heat";
  setTool: (tool: LabTool) => void;
  /** 打开/替换图像；切图时清空光标读数/levels/levelsPick/overlay（视口适配由 LabViewport 跟随） */
  setImage: (image: LabImage | null) => void;
  setViewport: (viewport: LabViewport) => void;
  setPointer: (pointer: LabPointer | null) => void;
  setPanelWidth: (width: number) => void;
  setPanelCollapsed: (collapsed: boolean) => void;
  setLevels: (levels: { black: number; white: number } | null) => void;
  setLevelsPick: (pick: "black" | "white" | null) => void;
  setOverlay: (tool: OverlayTool | null) => void;
  setSatMode: (mode: "check" | "heat") => void;
  /* ---- 划线 ---- */
  strokes: StrokeLine[];
  activeStrokeId: number | null;
  strokeDraft: StrokeLine | null;
  strokeStep: 1 | 2 | 4 | 8;
  strokeWidth: number;
  strokeHoverT: number | null;
  strokeSeq: number;
  startStroke: (point: { x: number; y: number }) => void;
  appendStrokePoint: (point: { x: number; y: number }) => void;
  finishStroke: () => void;
  cancelStroke: () => void;
  translateStroke: (id: number, dx: number, dy: number) => void;
  updateStroke: (id: number, patch: Partial<StrokeLine>) => void;
  removeStroke: (id: number) => void;
  setActiveStroke: (id: number | null) => void;
  toggleStrokeVisible: (id: number) => void;
  setStrokeStep: (step: 1 | 2 | 4 | 8) => void;
  setStrokeWidth: (width: number) => void;
  setStrokeHoverT: (t: number | null) => void;
}

export const useLabStore = create<LabState>()((set) => ({
  tool: "histogram",
  toolDir: 1,
  image: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  pointer: null,
  panel: loadPanel(),
  levels: null,
  levelsPick: null,
  overlay: null,
  satMode: "check",
  setTool: (tool) =>
    set((s) => {
      if (tool === s.tool) return s;
      const toolDir =
        TOOL_ORDER.indexOf(tool) > TOOL_ORDER.indexOf(s.tool) ? 1 : -1;
      return { tool, toolDir };
    }),
  setImage: (image) => set({ image, pointer: null, levels: null, levelsPick: null, overlay: null, strokes: [], activeStrokeId: null, strokeDraft: null, strokeHoverT: null }),
  setViewport: (viewport) => set({ viewport }),
  setPointer: (pointer) => set({ pointer }),
  setPanelWidth: (width) =>
    set((s) => {
      const panel = { ...s.panel, width };
      savePanel(panel);
      return { panel };
    }),
  setPanelCollapsed: (collapsed) =>
    set((s) => {
      const panel = { ...s.panel, collapsed };
      savePanel(panel);
      return { panel };
    }),
  setLevels: (levels) => set({ levels }),
  setLevelsPick: (levelsPick) => set({ levelsPick }),
  /* stroke */
  strokes: [],
  activeStrokeId: null,
  strokeDraft: null,
  strokeStep: 2,
  strokeWidth: 3,
  strokeHoverT: null,
  strokeSeq: 0,
  startStroke: (point) =>
    set((s) => {
      const id = s.strokeSeq + 1;
      const color = STROKE_COLORS[(id - 1) % STROKE_COLORS.length];
      const line: StrokeLine = { id, color, visible: true, asPoints: false, points: [point], samples: [], totalLen: 0 };
      return { strokeSeq: id, strokeDraft: line, activeStrokeId: id, strokes: [...s.strokes, line] };
    }),
  appendStrokePoint: (point) =>
    set((s) => {
      if (!s.strokeDraft) return s;
      const pts = s.strokeDraft.points;
      const last = pts[pts.length - 1];
      const dx = point.x - last.x, dy = point.y - last.y;
      if (Math.sqrt(dx * dx + dy * dy) < 1.5) return s;
      const draft = { ...s.strokeDraft, points: [...pts, point] };
      return { strokeDraft: draft, strokes: s.strokes.map((l) => l.id === draft.id ? draft : l) };
    }),
  finishStroke: () =>
    set((s) => {
      if (!s.strokeDraft) return s;
      const draft = s.strokeDraft;
      // 计算实际弧长（store 不能 import strokeAnalysis，内联计算）
      let len = 0;
      for (let i = 1; i < draft.points.length; i++) {
        const dx = draft.points[i].x - draft.points[i - 1].x;
        const dy = draft.points[i].y - draft.points[i - 1].y;
        len += Math.sqrt(dx * dx + dy * dy);
      }
      if (draft.points.length < 2 || len < 4) {
        const remaining = s.strokes.filter((l) => l.id !== draft.id);
        return { strokeDraft: null, strokes: remaining, activeStrokeId: remaining.length ? remaining[remaining.length - 1].id : null };
      }
      return { strokeDraft: null };
    }),
  cancelStroke: () =>
    set((s) => {
      if (!s.strokeDraft) return s;
      const remaining = s.strokes.filter((l) => l.id !== s.strokeDraft!.id);
      return { strokeDraft: null, strokes: remaining, activeStrokeId: remaining.length ? remaining[remaining.length - 1].id : null };
    }),
  translateStroke: (id, dx, dy) =>
    set((s) => ({
      strokes: s.strokes.map((l) => l.id === id ? { ...l, points: l.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : l),
    })),
  updateStroke: (id, patch) =>
    set((s) => ({ strokes: s.strokes.map((l) => l.id === id ? { ...l, ...patch } : l) })),
  removeStroke: (id) =>
    set((s) => {
      const strokes = s.strokes.filter((l) => l.id !== id);
      const activeStrokeId = s.activeStrokeId === id ? (strokes.length ? strokes[strokes.length - 1].id : null) : s.activeStrokeId;
      return { strokes, activeStrokeId, strokeHoverT: s.strokeHoverT !== null ? null : s.strokeHoverT };
    }),
  setActiveStroke: (id) => set({ activeStrokeId: id }),
  toggleStrokeVisible: (id) =>
    set((s) => ({
      strokes: s.strokes.map((l) => l.id === id ? { ...l, visible: !l.visible } : l),
      strokeHoverT: s.activeStrokeId === id && s.strokeHoverT !== null ? null : s.strokeHoverT,
    })),
  setStrokeStep: (step) => set({ strokeStep: step }),
  setStrokeWidth: (strokeWidth) => set({ strokeWidth }),
  setStrokeHoverT: (t) => set({ strokeHoverT: t }),
  setOverlay: (overlay) => set({ overlay }),
  setSatMode: (satMode) => set({ satMode }),
}));
