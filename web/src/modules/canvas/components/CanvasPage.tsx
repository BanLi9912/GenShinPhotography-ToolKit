import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChangeEvent as ReactChangeEvent,
  DragEvent as ReactDragEvent,
} from "react";
import { Layer, Line, Rect, Stage, Transformer } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import {
  CASCADE_OFFSET,
  DEFAULT_FONT_SIZE,
  MAX_ZOOM,
  MIN_ZOOM,
  newElementId,
  useCanvasSettings,
  useCanvasStore,
  type ConnectorElement,
} from "../store";
import { computeSnap, sameGuides } from "./alignSnap";
import type { GuideLine, SnapBox } from "./alignSnap";
import { applyStyleToRuns, runsAllBold, runsToText } from "./richText";
import { createImageAt, consumePendingImages } from "../incoming";
import { startCanvasPersistence } from "../persistence";
import { updateConnectorsLiveQuick } from "../connectorLive";
import { nodeWorldBox as calcWorldBox, type Box } from "../connectorGeometry";
import { LIBRARY_DRAG_MIME, getLibraryItemFile } from "../../library/api";
import { parseDragPayload } from "../../library/sendOut";
import { toast } from "../../../ui/toast";
import { ConnectorNode } from "./ConnectorNode";
import { ConnectionToolbar } from "./ConnectionToolbar";
import { GridDots } from "./GridDots";
import { ImageNode } from "./ImageNode";
import { TextEditor } from "./TextEditor";
import { TextNode } from "./TextNode";
import { TextToolbar } from "./TextToolbar";
import { registerContentLayer } from "../exportPng";
import { useCssToken } from "./useCssToken";
import "./CanvasPage.css";

/** 滚轮缩放系数：deltaY 每 100 约缩放 1.22 倍（指数连续缩放，滚轮/触控板都顺滑） */
const WHEEL_ZOOM_FACTOR = 0.002;
/** Transformer 锚点的命中区外扩（屏幕 px；按 1/zoom 折算进世界坐标，视觉不变、鼠标更好点） */
const ANCHOR_HIT_PAD = 6;
/** 锚点视觉尺寸（屏幕 px；同理由 1/zoom 折算，任何缩放下恒定） */
const ANCHOR_SCREEN_SIZE = 9;
/** 框选判定阈值（屏幕 px）：拖拽小于此视为单击，走"点空白取消选中" */
const MARQUEE_CLICK_THRESHOLD = 3;
/** 对齐吸附阈值（屏幕 px；按 1/zoom 折算进世界坐标，任何缩放下手感恒定） */
const SNAP_THRESHOLD = 5;

/** 框选矩形（世界坐标；x1/y1 随指针移动，可小于 x0/y0，渲染与判定时归一化） */
interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 轴对齐矩形（屏幕坐标），框选命中判定用 */
interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** 两个轴对齐矩形是否相交：框选与元素包围盒（均含旋转）的命中判定 */
function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** 目标为可编辑控件时不拦截按键（文本编辑/工具条输入框内正常打字） */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  );
}

/** 平移进行中/松手时安全地中断 Stage 拖拽 */
function stopStageDrag(stage: Konva.Stage | null) {
  if (stage?.isDragging()) stage.stopDrag();
}

/** 旋转手柄自定义图标：一段两端带箭头的圆弧（画在锚点底盘上） */
function drawRotaterIcon(
  ctx: CanvasRenderingContext2D,
  size: number,
  accent: string,
  baseFill: string,
) {
  const c = size / 2;
  // 底盘
  ctx.beginPath();
  ctx.arc(c, c, c - 0.5, 0, Math.PI * 2);
  ctx.fillStyle = baseFill;
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.stroke();
  // 圆弧（约 300°，缺口朝下）
  const r = size * 0.3;
  const start = Math.PI * 0.65;
  const end = Math.PI * 2.35;
  ctx.beginPath();
  ctx.arc(c, c, r, start, end);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // 两端箭头（沿切线方向）
  const tip = (angle: number, dir: 1 | -1) => {
    const px = c + r * Math.cos(angle);
    const py = c + r * Math.sin(angle);
    const tx = -Math.sin(angle) * dir;
    const ty = Math.cos(angle) * dir;
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const len = r * 0.7;
    const wid = r * 0.45;
    ctx.beginPath();
    ctx.moveTo(px + tx * len, py + ty * len);
    ctx.lineTo(px + nx * wid, py + ny * wid);
    ctx.lineTo(px - nx * wid, py - ny * wid);
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.fill();
  };
  tip(start, -1);
  tip(end, 1);
}

/**
 * M1 无限画布（任务 1.1 底子 + 1.2 文本块 + 1.3 图片元素 + 1.4 选择体系 + 1.5 自动保存 + 1.6 撤销/重做 + 1.7 对齐吸附）：
 * - Stage 铺满内容区；点阵网格；滚轮指针锚点缩放（5%–800%）；空格拖拽平移
 * - 文本工具（T）单击空白或任意工具下双击空白：创建文本并进入编辑
 * - 图片工具：打开文件选择器导入；拖入/Ctrl+V 粘贴亦可
 * - 单击选中（Transformer 选中框）、点空白取消；空白拖拽框选多选
 * - 多选整体移动：按住任一选中元素、或选区包围盒内空白处拖动（Konva
 *   startDrag 级联驱动全部选中节点，同帧移动）；Delete 删除 / Ctrl+C 复制 /
 *   图片 R 顺时针转 90°
 * - 单选图片出现 Transformer 手柄（等比缩放+旋转，锚点命中区外扩）；多选仅边框
 * - 对齐吸附（任务 1.7）：拖动靠近其他元素边线/中心线 5px（屏幕）内出参考线
 *   并磁吸，选中集合作为整体吸附；顶栏设置弹层可开关（useCanvasSettings）
 */
export function CanvasPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 元素 id → Konva 节点，Transformer 按选中 id 绑定
  const nodeRefs = useRef(new Map<string, Konva.Node>());
  // 框选矩形：state 驱动渲染，ref 供事件 handler 读最新值（window mouseup 兜底收尾）
  const marqueeRef = useRef<MarqueeRect | null>(null);
  /** 框选结束后吞掉紧随的 click（否则空白 click 会立刻清空刚框出的选区） */
  const suppressClickRef = useRef(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  // 对齐吸附（任务 1.7）：拖动中缓存的目标盒（其余元素，世界坐标）与当前参考线
  const snapTargetsRef = useRef<SnapBox[] | null>(null);
  const [guides, setGuides] = useState<GuideLine[] | null>(null);
  // 连线实时跟随（任务 1.9）：拖动开始时缓存的受影响的连线 id 集合
  const affectedConnectorsRef = useRef<Set<string> | null>(null);

  const viewport = useCanvasStore((s) => s.viewport);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const setPointer = useCanvasStore((s) => s.setPointer);
  const elements = useCanvasStore((s) => s.elements);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const editingId = useCanvasStore((s) => s.editingId);
  const tool = useCanvasStore((s) => s.tool);
  const addElement = useCanvasStore((s) => s.addElement);
  const setSelectedIds = useCanvasStore((s) => s.setSelectedIds);
  const setEditingId = useCanvasStore((s) => s.setEditingId);
  const setTool = useCanvasStore((s) => s.setTool);
  const selectionFramed = useCanvasStore((s) => s.selectionFramed);
  const connectMode = useCanvasStore((s) => s.connectMode);

  // Transformer 描边/手柄与框选颜色（canvas 绘制，经 token 桥接，随主题切换）
  const accent = useCssToken("--accent", "#8c6d1f");
  const anchorFill = useCssToken("--bg-elevated", "#ffffff");

  // 单选时的唯一选中元素：缩放/旋转手柄与悬浮工具条只在单选出现
  const selectedElements = elements.filter((e) => selectedIds.includes(e.id));
  const singleSelected =
    selectedElements.length === 1 ? selectedElements[0] : null;
  const editingElement = elements.find((e) => e.id === editingId) ?? null;

  const registerNode = useCallback((id: string, node: Konva.Node | null) => {
    if (node) nodeRefs.current.set(id, node);
    else nodeRefs.current.delete(id);
  }, []);

  const updateMarquee = useCallback((m: MarqueeRect | null) => {
    marqueeRef.current = m;
    setMarquee(m);
  }, []);

  /** Konva 节点 → 元素 id（nodeRefs 反查；Stage 拖拽/mousedown 事件统一处理用） */
  const findNodeId = (node: Konva.Node): string | null => {
    for (const [id, n] of nodeRefs.current) if (n === node) return id;
    return null;
  };

  /** 指针（屏幕坐标）是否落在选中集合的联合包围盒内（含旋转；框内空白也算） */
  const pointerInsideSelection = (ids: string[]): boolean => {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of ids) {
      const node = nodeRefs.current.get(id);
      if (!node || !node.isVisible()) continue;
      const r = node.getClientRect();
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    }
    if (minX === Infinity) return false;
    return (
      pointer.x >= minX &&
      pointer.x <= maxX &&
      pointer.y >= minY &&
      pointer.y <= maxY
    );
  };

  /** 节点的世界坐标包围盒（getClientRect 为屏幕坐标且含旋转，按 Stage 变换折算） */
  const nodeWorldBox = (node: Konva.Node): SnapBox | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const zoom = stage.scaleX();
    const r = node.getClientRect();
    return {
      x: (r.x - stage.x()) / zoom,
      y: (r.y - stage.y()) / zoom,
      width: r.width / zoom,
      height: r.height / zoom,
    };
  };

  /** 连线用世界盒（Box 格式，供 ConnectorNode 与 ConnectionToolbar） */
  const getBox = useCallback((id: string): Box | null => {
    const node = nodeRefs.current.get(id);
    const stage = stageRef.current;
    if (!node || !stage) return null;
    return calcWorldBox(node, stage);
  }, []);

  // 内容区尺寸跟随：Stage 宽高铺满
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 自动保存 + 会话恢复（任务 1.5）：启动读回上次画板，之后变更 1s 防抖落盘（幂等）
  useEffect(() => {
    startCanvasPersistence();
  }, []);

  // 空格平移：按住进入平移态；松开或窗口失焦立即结束（含进行中的拖拽）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isEditableTarget(e.target)) return;
      e.preventDefault(); // 阻止空格触发页面滚动
      setSpaceHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setSpaceHeld(false);
      setPanning(false);
      stopStageDrag(stageRef.current);
    };
    const onWindowBlur = () => {
      setSpaceHeld(false);
      setPanning(false);
      stopStageDrag(stageRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  // 快捷键（§2.1.4）：V 选择 / T 文本 / Esc 取消选中并回选择工具；
  // Delete 删除选中；Ctrl+C 复制选中；R 选中图片顺时针旋转 90°；
  // Ctrl+Z 撤销 / Ctrl+Y 重做（任务 1.6）；
  // Ctrl+B 对单选文本块整段切换加粗（编辑态由 contentEditable 原生处理）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const s = useCanvasStore.getState();
      if (e.ctrlKey || e.metaKey) {
        // 编辑态的 Ctrl+Z/B 等归 contentEditable/输入框原生行为，不拦截
        if (isEditableTarget(e.target)) return;
        if (e.key === "z" || e.key === "Z") {
          e.preventDefault(); // 拦下浏览器原生撤销
          s.undo();
        } else if (e.key === "y" || e.key === "Y") {
          e.preventDefault();
          s.redo();
        } else if (e.key === "b" || e.key === "B") {
          if (s.selectedIds.length !== 1) return;
          const el = s.elements.find((x) => x.id === s.selectedIds[0]);
          if (el?.type !== "text") return;
          e.preventDefault(); // 拦下浏览器书签栏快捷键
          s.updateTextProps(
            el.id,
            {
              runs: applyStyleToRuns(
                el.props.runs,
                0,
                runsToText(el.props.runs).length,
                { bold: !runsAllBold(el.props.runs) },
              ),
            },
            { label: "切换粗体" },
          );
        } else if (e.key === "c" || e.key === "C") {
          if (s.selectedIds.length === 0) return;
          e.preventDefault();
          s.duplicateElements(s.selectedIds);
        }
        return;
      }
      if (e.altKey || isEditableTarget(e.target)) return;
      if (e.key === "v" || e.key === "V") setTool("select");
      else if (e.key === "t" || e.key === "T") setTool("text");
      else if (e.key === "l" || e.key === "L") {
        const nonConn = s.selectedIds.filter(
          (id) => s.elements.find((x) => x.id === id)?.type !== "connector",
        );
        if (nonConn.length === 2) {
          s.addConnector(nonConn[0], nonConn[1], "end");
        } else {
          s.toggleConnectMode();
        }
      } else if (e.key === "Delete") {
        if (s.selectedIds.length > 0) s.removeElements(s.selectedIds);
      } else if (e.key === "r" || e.key === "R") {
        if (s.selectedIds.length > 0) s.rotateImages90(s.selectedIds);
      } else if (e.key === "Escape") {
        if (s.connectMode.active) {
          s.toggleConnectMode();
        } else {
          setSelectedIds([]);
          setTool("select");
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setTool, setSelectedIds]);

  // 阻止浏览器默认拖放行为（否则文件拖到画布外会被直接打开）
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // 框选完成（window mouseup 兜底：指针移出 Stage 再松手也要收尾）
  useEffect(() => {
    const onMouseUp = () => {
      const m = marqueeRef.current;
      if (!m) return;
      updateMarquee(null);
      const stage = stageRef.current;
      if (!stage) return;
      const zoom = stage.scaleX();
      const w = Math.abs(m.x1 - m.x0);
      const h = Math.abs(m.y1 - m.y0);
      // 微小拖拽视为单击，交给 click 走"点空白取消选中"
      if (w * zoom < MARQUEE_CLICK_THRESHOLD && h * zoom < MARQUEE_CLICK_THRESHOLD)
        return;
      const selRect: ScreenRect = {
        x: Math.min(m.x0, m.x1) * zoom + stage.x(),
        y: Math.min(m.y0, m.y1) * zoom + stage.y(),
        width: w * zoom,
        height: h * zoom,
      };
      const hitIds = new Set<string>();
      nodeRefs.current.forEach((node, id) => {
        if (!node.isVisible()) return; // 编辑中的文本节点隐藏，不参与框选
        if (rectsIntersect(selRect, node.getClientRect())) hitIds.add(id);
      });
      const s = useCanvasStore.getState();
      s.setSelectedIds(
        s.elements.filter((e) => hitIds.has(e.id)).map((e) => e.id),
      );
      suppressClickRef.current = true;
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [updateMarquee]);

  // 图片导入：落图管线提升到 incoming.ts（任务 M3.6，供 M3 送去画布复用），
  // 本组件只负责入口侧的落点换算与容器尺寸
  const importImageFile = useCallback(
    (file: File, world: { x: number; y: number }) =>
      createImageAt(file, world, containerRef.current),
    [],
  );

  /** 落点缺省值：指针在画布内取指针位置，否则视口中心 */
  const fallbackDropPoint = () => {
    const state = useCanvasStore.getState();
    if (state.pointer) return state.pointer;
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    return {
      x:
        (container.clientWidth / 2 - state.viewport.x) / state.viewport.zoom,
      y:
        (container.clientHeight / 2 - state.viewport.y) / state.viewport.zoom,
    };
  };

  // 跨模块送图消费（任务 M3.6）：M3「送去画布」只入待收队列，画布元素在挂载时
  // 才从 idb 水合——必须等水合完成后落图，否则元素被恢复动作整体覆盖。
  // 幂等守卫：水合只跑一次且消费即清空，重复执行不重复落图。
  useEffect(() => {
    let cancelled = false;
    void startCanvasPersistence()
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        const files = consumePendingImages();
        if (files.length === 0) return;
        const at = fallbackDropPoint();
        files.forEach((f, i) =>
          void importImageFile(f, {
            x: at.x + i * CASCADE_OFFSET,
            y: at.y + i * CASCADE_OFFSET,
          }),
        );
        toast(`已接收 ${files.length} 张图片`);
      });
    return () => {
      cancelled = true;
    };
  }, [importImageFile]);

  // 图片工具被选中：打开系统文件选择器（一次性动作，完成/取消后回选择工具）
  useEffect(() => {
    if (tool !== "image") return;
    const input = fileInputRef.current;
    if (!input) return;
    input.value = ""; // 允许重复选择同一文件
    input.click();
  }, [tool]);

  // 文件选择器取消（未选文件直接关窗）→ 回选择工具
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const onCancel = () => setTool("select");
    input.addEventListener("cancel", onCancel);
    return () => input.removeEventListener("cancel", onCancel);
  }, [setTool]);

  const handleFilePick = (e: ReactChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].filter((f) =>
      f.type.startsWith("image/"),
    );
    e.target.value = "";
    if (files.length > 0) {
      const at = fallbackDropPoint();
      files.forEach((f, i) =>
        void importImageFile(f, {
          x: at.x + i * CASCADE_OFFSET,
          y: at.y + i * CASCADE_OFFSET,
        }),
      );
    }
    setTool("select");
  };

  // Ctrl+V 粘贴剪贴板截图：落点为指针位置（指针不在画布则视口中心）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      e.preventDefault();
      const at = fallbackDropPoint();
      files.forEach((f, i) =>
        void importImageFile(f, {
          x: at.x + i * CASCADE_OFFSET,
          y: at.y + i * CASCADE_OFFSET,
        }),
      );
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importImageFile]);

  // Transformer 绑定选中节点（多选为全部选中节点）；文本属性变化后重算选中框
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    const nodes = selectedIds
      .filter((id) => id !== editingId)
      .map((id) => nodeRefs.current.get(id))
      .filter((n): n is Konva.Node => n !== undefined);
    // 虚线框选中态抑制 Transformer（仅显示虚线框，不显示大边框 + 手柄）
    if (selectionFramed) {
      tr.nodes([]);
      tr.getLayer()?.batchDraw();
      return;
    }
    tr.nodes(nodes);
    tr.forceUpdate();
    tr.getLayer()?.batchDraw();
  }, [selectedIds, editingId, elements, selectionFramed]);

  // Transformer 锚点调优：命中区外扩（视觉不变；按当前缩放折算，屏幕上恒定）
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    tr.find("._anchor").forEach((node) => {
      (node as Konva.Shape).hitFunc((context, shape) => {
        const pad = ANCHOR_HIT_PAD / (shape.getStage()?.scaleX() || 1);
        context.beginPath();
        context.rect(
          -pad,
          -pad,
          shape.width() + pad * 2,
          shape.height() + pad * 2,
        );
        context.fillShape(shape);
      });
    });
    const rotater = tr.findOne(".rotater") as Konva.Shape | undefined;
    rotater?.sceneFunc((context, shape) => {
      drawRotaterIcon(context._context, shape.width(), accent, anchorFill);
    });
  }, [accent, anchorFill]);

  // 滚轮缩放：以指针为锚点，缩放前后保持指针下的世界坐标不动
  const handleWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;

    const oldZoom = viewport.zoom;
    const newZoom = clampZoom(
      oldZoom * Math.exp(-e.evt.deltaY * WHEEL_ZOOM_FACTOR),
    );
    if (newZoom === oldZoom) return;

    const worldPoint = {
      x: (pointer.x - viewport.x) / oldZoom,
      y: (pointer.y - viewport.y) / oldZoom,
    };
    setViewport({
      x: pointer.x - worldPoint.x * newZoom,
      y: pointer.y - worldPoint.y * newZoom,
      zoom: newZoom,
    });
  };

  // Stage 拖拽（空格平移）。Konva 事件会冒泡：元素/手动 startDrag 的拖拽
  // 也会冒泡到这里，需排除非 Stage 的拖拽
  const handleDragStart = (e: KonvaEventObject<DragEvent>) => {
    if (e.target !== stageRef.current) {
      const draggedId = findNodeId(e.target);
      if (!draggedId) return;
      const s = useCanvasStore.getState();
      const movingIds = s.selectedIds.includes(draggedId)
        ? s.selectedIds
        : [draggedId];
      // 连线实时跟随（任务 1.9）：缓存受影响的连线 id 集合
      const movingSet = new Set(movingIds);
      const connIds = new Set<string>();
      for (const el of s.elements) {
        if (el.type !== "connector") continue;
        if (movingSet.has(el.props.fromId) || movingSet.has(el.props.toId))
          connIds.add(el.id);
      }
      affectedConnectorsRef.current = connIds;
      // 对齐吸附（任务 1.7）：缓存其余可见元素的包围盒作为吸附目标
      if (useCanvasSettings.getState().snapEnabled) {
        const targets: SnapBox[] = [];
        nodeRefs.current.forEach((node, id) => {
          if (movingSet.has(id) || !node.isVisible()) return;
          const box = nodeWorldBox(node);
          if (box) targets.push(box);
        });
        snapTargetsRef.current = targets;
      }
      return;
    }
    setPanning(true);
  };
  const handleDragMove = (e: KonvaEventObject<DragEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (e.target === stage) {
      setViewport({ x: stage.x(), y: stage.y(), zoom: stage.scaleX() });
      return;
    }
    const draggedId = findNodeId(e.target);
    if (!draggedId) return;
    const s = useCanvasStore.getState();
    const movingIds = s.selectedIds.includes(draggedId)
      ? s.selectedIds
      : [draggedId];
    const movingSet = new Set(movingIds);

    // 对齐吸附（任务 1.7）。Konva 每帧先摆好全部拖动节点再发 dragmove
    if (snapTargetsRef.current) {
      const movingNodes: Konva.Node[] = [];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const id of movingIds) {
        const node = nodeRefs.current.get(id);
        if (!node) continue;
        const box = nodeWorldBox(node);
        if (!box) continue;
        movingNodes.push(node);
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
      }
      if (movingNodes.length > 0) {
        const result = computeSnap(
          { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
          snapTargetsRef.current,
          SNAP_THRESHOLD / stage.scaleX(),
        );
        if (result.dx !== 0 || result.dy !== 0) {
          for (const node of movingNodes) {
            node.x(node.x() + result.dx);
            node.y(node.y() + result.dy);
          }
        }
        const nextGuides = result.guides.length > 0 ? result.guides : null;
        setGuides((prev) => (sameGuides(prev, nextGuides) ? prev : nextGuides));
      }
    }

    // 连线实时跟随（任务 1.9）：每帧命令式更新受影响连线的端点，不受吸附开关影响
    if (affectedConnectorsRef.current) {
      const conns = s.elements.filter(
        (el): el is ConnectorElement => el.type === "connector",
      );
      updateConnectorsLiveQuick(
        movingSet,
        conns,
        nodeRefs.current,
        stage,
      );
    }
  };
  const handleDragEnd = (e: KonvaEventObject<DragEvent>) => {
    const stage = stageRef.current;
    if (e.target === stage) {
      setPanning(false);
      setViewport({ x: stage.x(), y: stage.y(), zoom: stage.scaleX() });
      return;
    }
    // 元素拖拽结束：收尾吸附状态与连线跟随（任务 1.7、1.9）
    snapTargetsRef.current = null;
    affectedConnectorsRef.current = null;
    setGuides(null);
    // 多选整体移动视作一次操作（撤销粒度，任务 1.6）：首个
    // dragend 就把全部选中节点批量写回；其余节点的 dragend 冒泡到时坐标已一致，自然跳过
    const s = useCanvasStore.getState();
    const draggedId = findNodeId(e.target);
    if (!draggedId) return;
    const ids = s.selectedIds.includes(draggedId) ? s.selectedIds : [draggedId];
    const updates = ids.flatMap((id) => {
      const node = nodeRefs.current.get(id);
      const el = s.elements.find((x) => x.id === id);
      if (!node || !el) return [];
      // 未移动（如点击多选中的元素）不写回，避免无谓重渲染与空历史
      if (el.transform.x === node.x() && el.transform.y === node.y()) return [];
      return [{ id, transform: { ...el.transform, x: node.x(), y: node.y() } }];
    });
    if (updates.length > 0) s.setElementsTransforms(updates);
  };

  // 指针世界坐标：供状态栏显示（§6.3）；离开画布区置空。框选进行中同步更新终点
  const handleMouseMove = () => {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    setPointer({
      x: (pointer.x - stage.x()) / stage.scaleX(),
      y: (pointer.y - stage.y()) / stage.scaleY(),
    });
    if (marqueeRef.current) {
      updateMarquee({
        ...marqueeRef.current,
        x1: (pointer.x - stage.x()) / stage.scaleX(),
        y1: (pointer.y - stage.y()) / stage.scaleY(),
      });
    }
  };

  /**
   * mousedown 分发（Konva 事件冒泡到 Stage，统一处理）：
   * - 按住已选中元素：级联 startDrag 其余选中节点（多选整体移动，同帧驱动不闪）
   * - 按住空白且在选区包围盒内：全部选中节点 startDrag（按住框内任意处拖动）
   * - 其余空白：开始框选（选择工具、左键、非空格平移、非编辑态），原选区清空
   */
  const handleStageMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0 || tool !== "select" || spaceHeld) return;
    const s = useCanvasStore.getState();
    if (s.editingId) return;
    if (e.target !== stageRef.current) {
      // Transformer 锚点等不属于元素的节点不在此处理（findNodeId 为 null）
      const targetId = findNodeId(e.target);
      if (
        targetId &&
        s.selectedIds.length > 1 &&
        s.selectedIds.includes(targetId)
      ) {
        for (const id of s.selectedIds) {
          if (id !== targetId) nodeRefs.current.get(id)?.startDrag();
        }
      }
      return;
    }
    if (s.selectedIds.length > 0 && pointerInsideSelection(s.selectedIds)) {
      for (const id of s.selectedIds) nodeRefs.current.get(id)?.startDrag();
      return;
    }
    const world = stagePointerWorld();
    if (!world) return;
    setSelectedIds([]);
    updateMarquee({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
  };

  // 在世界坐标处创建文本块并进入编辑
  const createTextAt = (world: { x: number; y: number }) => {
    const id = newElementId();
    addElement({
      id,
      type: "text",
      transform: { x: world.x, y: world.y, w: 0, h: 0, rotation: 0 },
      props: {
        runs: [{ text: "" }],
        fontSize: DEFAULT_FONT_SIZE,
        color: null,
        align: "left",
      },
    });
    setEditingId(id);
  };

  const stagePointerWorld = () => {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return null;
    return {
      x: (pointer.x - stage.x()) / stage.scaleX(),
      y: (pointer.y - stage.y()) / stage.scaleY(),
    };
  };

  // 单击空白：文本工具下在该位置创建文本（点哪写哪）；其余工具为取消选中；
  // 连接模式中先退出模式
  const handleStageClick = (e: KonvaEventObject<MouseEvent>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (e.target !== stageRef.current) return;
    const s = useCanvasStore.getState();
    if (s.connectMode.active) {
      s.toggleConnectMode();
      return;
    }
    if (tool === "text") {
      const world = stagePointerWorld();
      if (world) createTextAt(world);
      return;
    }
    setSelectedIds([]);
  };

  // 双击空白：快捷创建文本（任意工具下均可，保留原快捷操作）
  const handleStageDblClick = (e: KonvaEventObject<MouseEvent>) => {
    if (e.target !== stageRef.current) return;
    const world = stagePointerWorld();
    if (world) createTextAt(world);
  };

  // 拖入落图（任务 M3.6 两分支）：
  // - M3 图库拖入：`dataTransfer.files` 在应用内拖拽必为空，故读自定义 MIME 的
  //   条目标识，经 library/api 回取 File 后按落点级联落图；
  // - OS 文件拖入：原 `dataTransfer.files` 链路，行为不变（回归高压线）
  const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    const stage = stageRef.current;
    if (!rect || !stage) return;
    const at = {
      x: (e.clientX - rect.left - stage.x()) / stage.scaleX(),
      y: (e.clientY - rect.top - stage.y()) / stage.scaleY(),
    };
    const raw = e.dataTransfer.getData(LIBRARY_DRAG_MIME);
    if (raw) {
      const items = parseDragPayload(raw);
      if (!items || items.length === 0) return;
      void (async () => {
        const files: File[] = [];
        for (const item of items) {
          try {
            const file = await getLibraryItemFile(item.libraryId, item.relPath);
            if (file) files.push(file);
            else console.warn("[canvas] 图库条目文件不存在", item.relPath);
          } catch (err) {
            console.warn("[canvas] 图库条目读取失败", item.relPath, err);
          }
        }
        files.forEach((f, i) =>
          void importImageFile(f, {
            x: at.x + i * CASCADE_OFFSET,
            y: at.y + i * CASCADE_OFFSET,
          }),
        );
      })();
      return;
    }
    const files = [...e.dataTransfer.files].filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    files.forEach((f, i) =>
      void importImageFile(f, {
        x: at.x + i * CASCADE_OFFSET,
        y: at.y + i * CASCADE_OFFSET,
      }),
    );
  };

  return (
    <div
      ref={containerRef}
      onMouseLeave={() => setPointer(null)}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={handleDrop}
      className={[
        "canvas-page",
        spaceHeld ? "canvas-page--pan-ready" : "",
        panning ? "canvas-page--panning" : "",
        tool === "text" ? "canvas-page--tool-text" : "",
        connectMode.active ? "canvas-page--connecting" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {size && (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          x={viewport.x}
          y={viewport.y}
          scaleX={viewport.zoom}
          scaleY={viewport.zoom}
          draggable={spaceHeld}
          onWheel={handleWheel}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onMouseMove={handleMouseMove}
          onMouseDown={handleStageMouseDown}
          onClick={handleStageClick}
          onDblClick={handleStageDblClick}
        >
          <Layer listening={false}>
            <GridDots />
          </Layer>
          <Layer ref={registerContentLayer}>
            {elements
              .filter((el) => el.type === "connector")
              .map((c) => (
                <ConnectorNode
                  key={c.id}
                  connector={c}
                  zoom={viewport.zoom}
                  getBox={getBox}
                />
              ))}
            {elements.map((el) =>
              el.type === "text" ? (
                <TextNode
                  key={el.id}
                  element={el}
                  spaceHeld={spaceHeld}
                  registerNode={registerNode}
                />
              ) : el.type === "image" ? (
                <ImageNode
                  key={el.id}
                  element={el}
                  spaceHeld={spaceHeld}
                  registerNode={registerNode}
                  onTransform={() => {
                    const stage = stageRef.current;
                    if (!stage) return;
                    const s = useCanvasStore.getState();
                    const conns = s.elements.filter(
                      (x): x is ConnectorElement =>
                        x.type === "connector",
                    );
                    updateConnectorsLiveQuick(
                      new Set(s.selectedIds),
                      conns,
                      nodeRefs.current,
                      stage,
                    );
                  }}
                />
              ) : null,
            )}
            {/* 虚线框（任务 1.9 交互迭代）：Ctrl+click 选中或点选模式源元素 */}
            {(selectionFramed || connectMode.sourceId) &&
              (() => {
                const framed: string[] = [];
                if (selectionFramed) {
                  for (const id of selectedIds) {
                    if (elements.find((e) => e.id === id)?.type !== "connector")
                      framed.push(id);
                  }
                }
                if (connectMode.sourceId && !framed.includes(connectMode.sourceId))
                  framed.push(connectMode.sourceId);
                return framed.map((id) => {
                  const box = getBox(id);
                  if (!box) return null;
                  return (
                    <Rect
                      key={`framed-${id}`}
                      x={box.x - 4 / viewport.zoom}
                      y={box.y - 4 / viewport.zoom}
                      width={box.w + (8 / viewport.zoom)}
                      height={box.h + (8 / viewport.zoom)}
                      stroke={accent}
                      strokeWidth={1.5 / viewport.zoom}
                      dash={[6 / viewport.zoom, 4 / viewport.zoom]}
                      listening={false}
                    />
                  );
                });
              })()}
            <Transformer
              ref={transformerRef}
              rotateEnabled={singleSelected?.type === "image"}
              resizeEnabled={singleSelected?.type === "image"}
              rotateAnchorCursor="grab"
              keepRatio
              flipEnabled={false}
              anchorSize={ANCHOR_SCREEN_SIZE / viewport.zoom}
              anchorCornerRadius={2 / viewport.zoom}
              anchorStroke={accent}
              anchorFill={anchorFill}
              anchorStrokeWidth={1 / viewport.zoom}
              borderStroke={accent}
              borderStrokeWidth={1 / viewport.zoom}
              rotateAnchorOffset={24 / viewport.zoom}
            />
            {guides?.map((g) => (
              <Line
                key={`${g.orientation}-${g.pos}`}
                points={
                  g.orientation === "v"
                    ? [g.pos, g.from, g.pos, g.to]
                    : [g.from, g.pos, g.to, g.pos]
                }
                stroke={accent}
                strokeWidth={1 / viewport.zoom}
                listening={false}
              />
            ))}
            {marquee && (
              <Rect
                x={Math.min(marquee.x0, marquee.x1)}
                y={Math.min(marquee.y0, marquee.y1)}
                width={Math.abs(marquee.x1 - marquee.x0)}
                height={Math.abs(marquee.y1 - marquee.y0)}
                stroke={accent}
                strokeWidth={1 / viewport.zoom}
                dash={[4 / viewport.zoom, 4 / viewport.zoom]}
                fill={accent}
                opacity={0.08}
                listening={false}
              />
            )}
          </Layer>
        </Stage>
      )}
      {editingElement?.type === "text" && (
        <TextEditor element={editingElement} />
      )}
      {singleSelected?.type === "text" && size && (
        <TextToolbar element={singleSelected} containerSize={size} />
      )}
      {singleSelected?.type === "connector" && size && (
        <ConnectionToolbar
          connector={singleSelected}
          getBox={getBox}
          containerSize={size}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        style={{ display: "none" }}
        onChange={handleFilePick}
      />
    </div>
  );
}
