import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 缩放范围（开发文档 §2.1.1 M1-01：5%–800%） */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

/** 文本块字号默认值与预设档（悬浮工具条预设弹层） */
export const DEFAULT_FONT_SIZE = 16;
export const FONT_SIZE_PRESETS = [12, 14, 16, 20, 28, 36, 48, 72];
/** 悬浮工具条字号输入框的允许范围（键盘输入值钳制在此区间） */
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 200;

/** 一次导入多张图片 / 复制选中元素时的级联偏移（世界 px），避免完全重叠 */
export const CASCADE_OFFSET = 16;

/** 撤销/重做步数上限（任务 1.6：elements 快照栈） */
export const HISTORY_LIMIT = 100;
/** 连续同类微调的历史合并窗口（ms）：如取色拖动逐帧写回，并为一个撤销步 */
const HISTORY_COALESCE_MS = 1000;

/** 画布视口：对应文档 §4.3 的 viewport（Stage 的偏移与缩放，1 = 100%） */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * 元素变换（§4.3 transform：坐标/尺寸/旋转）。
 * 文本块的 w/h 不使用：宽度随内容自适应（§2.1.2 M1-10），存 0 占位。
 */
export interface Transform {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

interface ElementBase {
  id: string;
  transform: Transform;
}

/**
 * 局部样式段：文本内容 = 各段 text 拼接（\n 分行）；
 * bold/fontSize/color 为覆盖块级缺省的局部样式（undefined = 继承块级）。
 * 段经 normalizeRuns 规整（相邻同样式合并、无空段）。
 */
export interface StyleRun {
  text: string;
  bold?: boolean;
  fontSize?: number;
  color?: string;
}

/**
 * 文本块（任务 1.2）。内容按样式段存储（支持局部粗体/字号/颜色），
 * fontSize/color/align 为块级缺省；块级 color 为 null 时跟随主题 --text-1。
 */
export interface TextElement extends ElementBase {
  type: "text";
  props: {
    runs: StyleRun[];
    fontSize: number;
    color: string | null;
    align: "left" | "center" | "right";
  };
}

/**
 * 图片（任务 1.3）。props 只存资产 id（§4.3 blob-ref，任务 1.5 起）：
 * 二进制本体在 IndexedDB assets 表，渲染 URL 在 assets.ts 内存缓存。
 */
export interface ImageElement extends ElementBase {
  type: "image";
  props: {
    assetId: string;
  };
}

/**
 * 连接线（任务 1.9）。连接两个元素的贝塞尔曲线，两端吸附元素边缘；
 * color: null = 跟随主题 --accent；存储进 elements 数组以复用撤销/持久化/导出。
 */
export interface ConnectorProps {
  fromId: string;
  toId: string;
  color: string | null;
  arrow: "end" | "both" | "none";
}

export interface ConnectorElement extends ElementBase {
  type: "connector";
  props: ConnectorProps;
}

export type CanvasElement = TextElement | ImageElement | ConnectorElement;
export type TextProps = TextElement["props"];

/** 历史记录条目（撤销/重做快照 + 历史面板展示） */
export interface HistoryEntry {
  elements: CanvasElement[];
  /** 操作名（历史面板展示），如 新建文本 / 移动 3 个元素 / 文本颜色 */
  label: string;
  /** 入栈时间（ms）：连续微调合并与面板时间显示用 */
  at: number;
  /** 合并键：与上一步相同且间隔在合并窗口内时，不再新压快照（取色拖动等连续微调） */
  coalesce?: string;
}

/** 变更动作可选的历史标注：label 覆盖默认操作名；coalesce 启用连续微调合并 */
export interface HistoryHint {
  label?: string;
  coalesce?: string;
}

/**
 * 画布工具（§2.1.4 快捷键体系：V 选择 / T 文本）。
 * image 为一次性动作入口（打开文件选择器），完成后回落 select；
 * 连接线经 L 快捷键/侧边工具栏动作按钮创建（非持续态 tool）；note 为占位。
 */
export type CanvasTool = "select" | "text" | "image";

interface CanvasState {
  viewport: Viewport;
  /** 指针所在的世界坐标（状态栏显示用；离开画布区为 null） */
  pointer: { x: number; y: number } | null;
  /** 画布元素，数组顺序即图层顺序（§4.1：元素顺序即图层顺序） */
  elements: CanvasElement[];
  /** 当前选中元素 id 集（任务 1.4 起支持多选：单击单选 / 框选多选），顺序随 elements */
  selectedIds: string[];
  /** 正在编辑文本的元素 id（编辑态由 HTML contentEditable 覆盖层承担） */
  editingId: string | null;
  /** 当前工具：text 时单击空白创建文本；image 时打开文件选择器 */
  tool: CanvasTool;
  /** Ctrl+click 加选构成的选中集合；true 时显示虚线框、抑制 Transformer（任务 1.9 交互迭代） */
  selectionFramed: boolean;
  /** 连接线点选模式（L/按钮进入，Esc/创建完成退出）；不入历史快照、不入 BoardDoc */
  connectMode: { active: boolean; sourceId: string | null };
  /** 上次自动保存成功的时间戳（ms，状态栏显示用）；null = 本次会话尚未保存 */
  lastSavedAt: number | null;
  /** 撤销栈（任务 1.6）：操作历史快照，最新在末尾；上限 HISTORY_LIMIT */
  past: HistoryEntry[];
  /** 重做栈：撤销退下的快照，最新在末尾；任何新元素变更即清空 */
  future: HistoryEntry[];
  setViewport: (viewport: Viewport) => void;
  setPointer: (pointer: { x: number; y: number } | null) => void;
  /** 添加元素并选中（新建/拖入/粘贴后的自然后续操作是调整它） */
  addElement: (element: CanvasElement) => void;
  removeElements: (ids: string[], label?: string) => void;
  /** 批量写回元素变换（拖拽/变换手柄结束；多选整体移动一次写回，撤销算一步） */
  setElementsTransforms: (
    updates: { id: string; transform: Transform }[],
    label?: string,
  ) => void;
  updateTextProps: (
    id: string,
    patch: Partial<TextProps>,
    hint?: HistoryHint,
  ) => void;
  /** 复制选中元素（Ctrl+C）：副本级联偏移放置，并选中副本 */
  duplicateElements: (ids: string[]) => void;
  /** 选中图片顺时针旋转 90°（R 键；文本忽略） */
  rotateImages90: (ids: string[]) => void;
  /** 选中两个元素创建连接线（L 键/工具栏按钮；同一无序对去重） */
  addConnector: (fromId: string, toId: string, arrow?: ConnectorProps["arrow"]) => void;
  /** 更新连接线样式（颜色/箭头；任务 1.9） */
  updateConnectorProps: (
    id: string,
    patch: Partial<ConnectorProps>,
  ) => void;
  /** Ctrl+click 加选/退选元素（任务 1.9 交互迭代） */
  ctrlToggleSelected: (id: string) => void;
  /** 连接线点选模式进入/退出（L 键/工具栏按钮切换） */
  toggleConnectMode: () => void;
  /** 连接线点选模式：设置源元素（null = 清空） */
  setConnectSource: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
  setEditingId: (id: string | null) => void;
  setTool: (tool: CanvasTool) => void;
  setLastSavedAt: (t: number) => void;
  /** 会话恢复（任务 1.5）：整体替换元素与视口，清空选中/编辑态与历史栈 */
  hydrate: (elements: CanvasElement[], viewport: Viewport) => void;
  /** 撤销/重做（任务 1.6，Ctrl+Z / Ctrl+Y）：回退/前进一步，选中与编辑态收敛到仍存在的元素 */
  undo: () => void;
  redo: () => void;
  /** 历史面板跳转：负 = 撤销 |delta| 步，正 = 重做 delta 步（一步定位） */
  jumpHistory: (delta: number) => void;
}

/** 图片绕视觉中心顺时针转 90°：Konva 旋转绕节点原点 (x,y)，需补偿位移使中心不动 */
function rotate90AroundCenter(t: Transform): Transform {
  const rad0 = (t.rotation * Math.PI) / 180;
  const rad1 = rad0 + Math.PI / 2;
  const cx = t.x + (t.w / 2) * Math.cos(rad0) - (t.h / 2) * Math.sin(rad0);
  const cy = t.y + (t.w / 2) * Math.sin(rad0) + (t.h / 2) * Math.cos(rad0);
  return {
    ...t,
    x: cx - (t.w / 2) * Math.cos(rad1) + (t.h / 2) * Math.sin(rad1),
    y: cy - (t.w / 2) * Math.sin(rad1) - (t.h / 2) * Math.cos(rad1),
    rotation: (t.rotation + 90) % 360,
  };
}

/**
 * 变更类动作公用：当前 elements 压入撤销栈（超上限丢最旧），并清空重做栈。
 * hint.coalesce 与上一步相同且间隔在合并窗口内时并入上一步（只滚动时间戳，
 * 取色拖动等逐帧微调不至于一次拖动产生几十个撤销步）。
 */
function pushHistory(
  s: Pick<CanvasState, "elements" | "past" | "future">,
  hint: { label: string; coalesce?: string },
): Pick<CanvasState, "past" | "future"> {
  const now = Date.now();
  const top = s.past[s.past.length - 1];
  if (
    hint.coalesce !== undefined &&
    s.future.length === 0 &&
    top?.coalesce === hint.coalesce &&
    now - top.at < HISTORY_COALESCE_MS
  )
    return { past: [...s.past.slice(0, -1), { ...top, at: now }], future: [] };
  return {
    past: [
      ...s.past.slice(-(HISTORY_LIMIT - 1)),
      {
        elements: s.elements,
        label: hint.label,
        at: now,
        coalesce: hint.coalesce,
      },
    ],
    future: [],
  };
}

/** 文本属性补丁 → 默认操作名（调用方未显式给 label 时用） */
function textPatchLabel(patch: Partial<TextProps>): string {
  const labels: Record<keyof TextProps, string> = {
    runs: "编辑文本",
    fontSize: "调整字号",
    color: "文本颜色",
    align: "文本对齐",
  };
  const keys = Object.keys(patch) as (keyof TextProps)[];
  return keys.length === 1 ? labels[keys[0]] : "修改文本";
}

/** 撤销/重做落态公用：选中与编辑态收敛到快照中仍存在的元素，同时退出连接模式 */
function reconcileSelection(
  s: Pick<CanvasState, "selectedIds" | "editingId" | "connectMode">,
  elements: CanvasElement[],
): Pick<CanvasState, "selectedIds" | "editingId" | "selectionFramed" | "connectMode"> {
  const ids = new Set(elements.map((e) => e.id));
  return {
    selectedIds: s.selectedIds.filter((id) => ids.has(id)),
    editingId: s.editingId && ids.has(s.editingId) ? s.editingId : null,
    selectionFramed: false,
    connectMode: { active: false, sourceId: null },
  };
}

/**
 * M1 画布状态。视口（缩放/平移）与指针坐标供状态栏；
 * 元素/选中/编辑态是任务 1.2 起的内容主体；任务 1.5 起 elements/viewport
 * 由 persistence.ts 自动保存并在启动时恢复；任务 1.6 撤销/重做为
 * elements 快照栈（past/future），变更类动作经 pushHistory 留快照。
 */
export const useCanvasStore = create<CanvasState>()((set, get) => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  pointer: null,
  elements: [],
  selectedIds: [],
  editingId: null,
  tool: "select",
  selectionFramed: false,
  connectMode: { active: false, sourceId: null },
  lastSavedAt: null,
  past: [],
  future: [],
  setViewport: (viewport) => set({ viewport }),
  setPointer: (pointer) => set({ pointer }),
  addElement: (element) =>
    set((s) => ({
      ...pushHistory(s, {
        label: element.type === "text" ? "新建文本" : "导入图片",
      }),
      elements: [...s.elements, element],
      selectedIds: [element.id],
    })),
  removeElements: (ids, label) =>
    set((s) => {
      const idSet = new Set(ids);
      const elements = s.elements.filter((e) => {
        if (idSet.has(e.id)) return false;
        // 级联删除：连接线的任一端被删则连线也删（同一历史步）
        if (e.type === "connector")
          return !(idSet.has(e.props.fromId) || idSet.has(e.props.toId));
        return true;
      });
      const removed = s.elements.length - elements.length;
      if (removed === 0) return {}; // 无命中不产生历史
      return {
        ...pushHistory(s, { label: label ?? `删除 ${removed} 个元素` }),
        elements,
        selectedIds: s.selectedIds.filter((id) => !idSet.has(id)),
        editingId: s.editingId && idSet.has(s.editingId) ? null : s.editingId,
        connectMode:
          s.connectMode.sourceId && idSet.has(s.connectMode.sourceId)
            ? { ...s.connectMode, sourceId: null }
            : s.connectMode,
      };
    }),
  setElementsTransforms: (updates, label) =>
    set((s) => {
      if (updates.length === 0) return {};
      const byId = new Map(updates.map((u) => [u.id, u.transform]));
      return {
        ...pushHistory(s, {
          label:
            label ??
            (updates.length > 1 ? `移动 ${updates.length} 个元素` : "移动元素"),
        }),
        elements: s.elements.map((e) => {
          const transform = byId.get(e.id);
          return transform ? { ...e, transform } : e;
        }),
      };
    }),
  updateTextProps: (id, patch, hint) =>
    set((s) => {
      const target = s.elements.find((e) => e.id === id);
      if (target?.type !== "text") return {}; // 无命中不产生历史
      // 无实际变化不产生历史（如打开编辑器原样提交）：runs 深比较，其余引用比较
      const changed = Object.entries(patch).some(([key, value]) => {
        const k = key as keyof TextProps;
        if (k === "runs")
          return JSON.stringify(value) !== JSON.stringify(target.props.runs);
        return target.props[k] !== value;
      });
      if (!changed) return {};
      return {
        ...pushHistory(s, {
          label: hint?.label ?? textPatchLabel(patch),
          coalesce: hint?.coalesce,
        }),
        elements: s.elements.map((e) =>
          e.id === id && e.type === "text"
            ? { ...e, props: { ...e.props, ...patch } }
            : e,
        ),
      };
    }),
  duplicateElements: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const sources = s.elements.filter(
        (e) => idSet.has(e.id) && e.type !== "connector",
      );
      if (sources.length === 0) return {}; // 无有效源（连线不参与复制）
      const copies: CanvasElement[] = sources.map((e): CanvasElement => {
        const transform = {
          ...e.transform,
          x: e.transform.x + CASCADE_OFFSET,
          y: e.transform.y + CASCADE_OFFSET,
        };
        if (e.type === "text")
          return {
            ...e,
            id: newElementId(),
            transform,
            props: { ...e.props, runs: e.props.runs.map((r) => ({ ...r })) },
          };
        return { ...e, id: newElementId(), transform, props: { ...e.props } } as CanvasElement;
      });
      return {
        ...pushHistory(s, { label: `复制 ${copies.length} 个元素` }),
        elements: [...s.elements, ...copies],
        selectedIds: copies.map((c) => c.id),
      };
    }),
  rotateImages90: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      // 未命中图片（如选中文本按 R）不产生历史
      if (!s.elements.some((e) => idSet.has(e.id) && e.type === "image"))
        return {};
      return {
        ...pushHistory(s, { label: "旋转图片 90°" }),
        elements: s.elements.map((e) =>
          idSet.has(e.id) && e.type === "image"
            ? { ...e, transform: rotate90AroundCenter(e.transform) }
            : e,
        ),
      };
    }),
  addConnector: (fromId, toId, arrow = "end") =>
    set((s) => {
      if (fromId === toId) return {}; // 自环忽略
      // 同一无序对去重：已存在则选中已有线
      const existing = s.elements.find(
        (e): e is ConnectorElement =>
          e.type === "connector" &&
          ((e.props.fromId === fromId && e.props.toId === toId) ||
            (e.props.fromId === toId && e.props.toId === fromId)),
      );
      if (existing) return { selectedIds: [existing.id] };
      const connector: ConnectorElement = {
        id: newElementId(),
        type: "connector",
        transform: { x: 0, y: 0, w: 0, h: 0, rotation: 0 },
        props: { fromId, toId, color: null, arrow },
      };
      return {
        ...pushHistory(s, { label: "新建连接线" }),
        elements: [...s.elements, connector],
        selectedIds: [connector.id],
        selectionFramed: false,
      };
    }),
  updateConnectorProps: (id, patch) =>
    set((s) => {
      const target = s.elements.find((e) => e.id === id);
      if (target?.type !== "connector") return {}; // 无命中不产生历史
      const changed = Object.entries(patch).some(
        ([key, value]) =>
          target.props[key as keyof ConnectorProps] !== value,
      );
      if (!changed) return {};
      return {
        ...pushHistory(s, { label: "连接线样式" }),
        elements: s.elements.map((e) =>
          e.id === id && e.type === "connector"
            ? { ...e, props: { ...e.props, ...patch } }
            : e,
        ),
      };
    }),
  ctrlToggleSelected: (id) =>
    set((s) => {
      // connector 不参与 Ctrl+click 选中
      if (s.elements.find((e) => e.id === id)?.type === "connector") return {};
      // 当前选中含 connector → 全新起点
      const hasConnector = s.selectedIds.some(
        (sid) => s.elements.find((e) => e.id === sid)?.type === "connector",
      );
      if (hasConnector) {
        const framed = false; // 单个元素不框
        return { selectedIds: [id], selectionFramed: framed };
      }
      const idx = s.selectedIds.indexOf(id);
      const next =
        idx >= 0
          ? s.selectedIds.filter((x) => x !== id)
          : [...s.selectedIds, id];
      const framed = next.length > 0;
      // 结果恰为 2 个非 connector 元素 → 自动创建双端圆点连线
      if (next.length === 2) {
        const nonConnIds = next.filter(
          (sid) => s.elements.find((e) => e.id === sid)?.type !== "connector",
        );
        if (nonConnIds.length === 2) {
          const existing = s.elements.find(
            (e): e is ConnectorElement =>
              e.type === "connector" &&
              ((e.props.fromId === nonConnIds[0] && e.props.toId === nonConnIds[1]) ||
                (e.props.fromId === nonConnIds[1] && e.props.toId === nonConnIds[0])),
          );
          if (existing) return { selectedIds: [existing.id], selectionFramed: false };
          const connector: ConnectorElement = {
            id: newElementId(),
            type: "connector",
            transform: { x: 0, y: 0, w: 0, h: 0, rotation: 0 },
            props: { fromId: nonConnIds[0], toId: nonConnIds[1], color: null, arrow: "both" },
          };
          return {
            ...pushHistory(s, { label: "新建连接线" }),
            elements: [...s.elements, connector],
            selectedIds: [connector.id],
            selectionFramed: false,
          };
        }
      }
      return { selectedIds: next, selectionFramed: framed };
    }),
  toggleConnectMode: () =>
    set((s) => ({
      connectMode: s.connectMode.active
        ? { active: false, sourceId: null }
        : { active: true, sourceId: null },
      selectionFramed: false,
    })),
  setConnectSource: (id) =>
    set((s) => ({ connectMode: { ...s.connectMode, sourceId: id } })),
  setSelectedIds: (selectedIds) => set({ selectedIds, selectionFramed: false }),
  setEditingId: (editingId) => set({ editingId }),
  setTool: (tool) => set({ tool }),
  setLastSavedAt: (lastSavedAt) => set({ lastSavedAt }),
  hydrate: (elements, viewport) =>
    set({
      elements,
      viewport,
      selectedIds: [],
      editingId: null,
      selectionFramed: false,
      connectMode: { active: false, sourceId: null },
      past: [],
      future: [],
    }),
  undo: () => get().jumpHistory(-1),
  redo: () => get().jumpHistory(1),
  jumpHistory: (delta) =>
    set((s) => {
      if (delta === 0) return {};
      const undoing = delta < 0;
      const stack = undoing ? s.past : s.future;
      const n = Math.min(Math.abs(delta), stack.length);
      if (n === 0) return {};
      // 状态链 [当前, 途经…, 目标]（n+1 个）；相邻两者的"产生操作"= 后者的 label
      const chain: HistoryEntry[] = [
        { elements: s.elements, label: "", at: 0 },
        ...[...stack].reverse().slice(0, n),
      ];
      const steps: HistoryEntry[] = chain.slice(0, n).map((st, j) => ({
        elements: st.elements,
        label: chain[j + 1].label,
        at: chain[j + 1].at,
      }));
      const target = chain[n];
      return undoing
        ? {
            elements: target.elements,
            past: s.past.slice(0, -n),
            future: [...s.future, ...steps],
            ...reconcileSelection(s, target.elements),
          }
        : {
            elements: target.elements,
            past: [...s.past, ...steps],
            future: s.future.slice(0, -n),
            ...reconcileSelection(s, target.elements),
          };
    }),
}));

/** 元素 id（§4.3 elements[].id） */
export function newElementId(): string {
  return crypto.randomUUID();
}

/**
 * 画布设置（任务 1.7 起）：与画板文档（elements/viewport，IndexedDB 持久化，
 * 见 persistence.ts）分离，走 localStorage（仿应用壳 theme.ts 的 persist 用法）。
 */
interface CanvasSettingsState {
  /** 对齐吸附：拖动元素靠近其他元素边线/中心线时显示参考线并吸附（阈值屏幕 5px） */
  snapEnabled: boolean;
  setSnapEnabled: (on: boolean) => void;
}

export const useCanvasSettings = create<CanvasSettingsState>()(
  persist(
    (set) => ({
      snapEnabled: true,
      setSnapEnabled: (snapEnabled) => set({ snapEnabled }),
    }),
    { name: "ystk-canvas-settings" },
  ),
);
