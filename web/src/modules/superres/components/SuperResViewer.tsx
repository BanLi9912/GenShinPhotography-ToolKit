import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { SuperResImage } from "../store";
import "./SuperResViewer.css";

/** 缩放范围与滚轮系数（口径同 M4 画布 / M3 查看器） */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const WHEEL_ZOOM_FACTOR = 0.002;

/** 对比分割线：初始居中，键盘每步 2%；一侧窄于 16% 时淡出该侧角标（避免压住分割线） */
const SPLIT_DEFAULT = 0.5;
const SPLIT_KEY_STEP = 0.02;
const TAG_HIDE_RATIO = 0.16;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function clampSplit(split: number): number {
  return Math.min(1, Math.max(0, split));
}

/** 结果相对原图的倍率文案（2 → `2x`、1.5 → `1.5x`） */
function ratioText(ratio: number): string {
  return `${Math.round(ratio * 100) / 100}x`;
}

function FitIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9V4h5" />
      <path d="M15 4h5v5" />
      <path d="M20 15v5h-5" />
      <path d="M9 20H4v-5" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 7 4 12 9 17" />
      <polyline points="15 7 20 12 15 17" />
    </svg>
  );
}

export interface SuperResViewerProps {
  /** 处理结果（分割线右侧：超分 / 纹理保全输出） */
  image: SuperResImage;
  /** 处理前原图（分割线左侧）；缺省时退化为无分割线的单图查看 */
  original?: SuperResImage | null;
}

/**
 * 超分结果小窗：左半原图 / 右半结果，中间一条可左右拖动的分割线做**同位置细节对比**；
 * 框内滚轮缩放（光标锚定）、指针拖拽平移，底部提供 适配窗口 / 缩小 / 放大 / 1:1。
 *
 * 尺寸兼容：结果可能是原尺寸（压缩回原分辨率）也可能被放大（2x/3x/4x）。
 * 左半原图按 `结果宽/原图宽` 的同倍率画进结果的像素坐标系——因此无论结果同尺寸还是
 * 变大，两侧都落在同一矩形里逐像素对齐（1:1 时屏幕上 1 像素 = 结果的 1 像素），
 * 分割线两侧才是"同一处细节"的前后对照。
 */
export function SuperResViewer({ image, original }: SuperResViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef<string | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const splitRef = useRef<number | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [split, setSplit] = useState(SPLIT_DEFAULT);
  const [panning, setPanning] = useState(false);
  const [splitDragging, setSplitDragging] = useState(false);

  const fitToStage = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return;
    // cover：填满画框不留灰边，超出部分居中裁掉，可拖拽查看
    const zoom = clampZoom(Math.max(w / image.width, h / image.height));
    setView({
      x: (w - image.width * zoom) / 2,
      y: (h - image.height * zoom) / 2,
      zoom,
    });
  }, [image.height, image.width]);

  // 打开/换图时自动适配一次，并把分割线归位居中
  useEffect(() => {
    if (fittedRef.current !== image.url) {
      fittedRef.current = image.url;
      setSplit(SPLIT_DEFAULT);
      fitToStage();
    }
  }, [fitToStage, image.url]);

  // 滚轮缩放：以光标为锚点，缩放前后光标下的像素不动
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((prev) => {
        const oldZoom = prev.zoom;
        const newZoom = clampZoom(
          oldZoom * Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR),
        );
        if (newZoom === oldZoom) return prev;
        const wx = (px - prev.x) / oldZoom;
        const wy = (py - prev.y) / oldZoom;
        return { x: px - wx * newZoom, y: py - wy * newZoom, zoom: newZoom };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const el = stageRef.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((prev) => {
      const newZoom = clampZoom(prev.zoom * factor);
      if (newZoom === prev.zoom) return prev;
      const wx = (cx - prev.x) / prev.zoom;
      const wy = (cy - prev.y) / prev.zoom;
      return { x: cx - wx * newZoom, y: cy - wy * newZoom, zoom: newZoom };
    });
  };

  const zoomToActual = () => {
    const el = stageRef.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((prev) => {
      const wx = (cx - prev.x) / prev.zoom;
      const wy = (cy - prev.y) / prev.zoom;
      return { x: cx - wx, y: cy - wy, zoom: 1 };
    });
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: view.x,
      originY: view.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || e.pointerId !== pan.pointerId) return;
    setView((prev) => ({
      x: pan.originX + (e.clientX - pan.startX),
      y: pan.originY + (e.clientY - pan.startY),
      zoom: prev.zoom,
    }));
  };

  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== e.pointerId) return;
    panRef.current = null;
    setPanning(false);
  };

  /** 分割线拖拽：指针捕获在把手自身，与画框平移互不干扰 */
  const splitFromClientX = (clientX: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    setSplit(clampSplit((clientX - rect.left) / rect.width));
  };

  const handleSplitPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 不落到画框的平移拖拽上
    splitRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setSplitDragging(true);
    splitFromClientX(e.clientX);
  };

  const handleSplitPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (splitRef.current !== e.pointerId) return;
    splitFromClientX(e.clientX);
  };

  const endSplit = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (splitRef.current !== e.pointerId) return;
    splitRef.current = null;
    setSplitDragging(false);
  };

  const handleSplitKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      next = split - SPLIT_KEY_STEP;
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      next = split + SPLIT_KEY_STEP;
    } else if (e.key === "Home") {
      next = 0;
    } else if (e.key === "End") {
      next = 1;
    } else if (e.key === "Enter" || e.key === " ") {
      next = SPLIT_DEFAULT;
    }
    if (next === null) return;
    e.preventDefault();
    setSplit(clampSplit(next));
  };

  // 左半原图：等比映射进结果的像素坐标系（同尺寸时即 1:1）
  const bounds = original
    ? {
        x: (image.width / original.width) * view.zoom,
        y: (image.height / original.height) * view.zoom,
      }
    : null;
  const sizeText = original
    ? original.width === image.width && original.height === image.height
      ? `${image.width}×${image.height} · 原尺寸`
      : `${original.width}×${original.height} → ${image.width}×${image.height} · ${ratioText(image.width / original.width)}`
    : `${image.width}×${image.height}`;

  return (
    <div className="superres-viewer">
      <div
        ref={stageRef}
        className={`superres-viewer__stage${panning ? " is-panning" : ""}${
          splitDragging ? " is-split-dragging" : ""
        }`}
        title={
          original
            ? "拖动分割线对比原图与结果 · 滚轮缩放 · 拖拽平移"
            : "滚轮缩放 · 拖拽平移"
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {/* 右半：结果（铺底） */}
        <img
          className="superres-viewer__img"
          src={image.url}
          alt={image.name}
          width={image.width}
          height={image.height}
          draggable={false}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          }}
        />
        {/* 左半：原图（同位移同缩放进结果坐标系，整层按分割线裁切） */}
        {original && bounds && (
          <div
            className="superres-viewer__layer"
            style={{ clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}
          >
            <img
              className="superres-viewer__img"
              src={original.url}
              alt={original.name}
              width={original.width}
              height={original.height}
              draggable={false}
              style={{
                transform: `translate(${view.x}px, ${view.y}px) scale(${bounds.x}, ${bounds.y})`,
              }}
            />
          </div>
        )}
        {original && (
          <>
            <span
              className={`superres-viewer__tag superres-viewer__tag--before${
                split < TAG_HIDE_RATIO ? " is-hidden" : ""
              }`}
            >
              原图
            </span>
            <span
              className={`superres-viewer__tag superres-viewer__tag--after${
                split > 1 - TAG_HIDE_RATIO ? " is-hidden" : ""
              }`}
            >
              结果
            </span>
            <div
              className="superres-viewer__handle"
              style={{ left: `${split * 100}%` }}
              role="slider"
              tabIndex={0}
              aria-label="原图与结果对比分割线"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(split * 100)}
              title="左右拖动对比原图与结果 · 双击居中"
              onPointerDown={handleSplitPointerDown}
              onPointerMove={handleSplitPointerMove}
              onPointerUp={endSplit}
              onPointerCancel={endSplit}
              onKeyDown={handleSplitKeyDown}
              onDoubleClick={() => setSplit(SPLIT_DEFAULT)}
            >
              <span className="superres-viewer__handle-line" aria-hidden="true" />
              <span className="superres-viewer__handle-grip" aria-hidden="true">
                <GripIcon />
              </span>
            </div>
          </>
        )}
      </div>
      <div className="superres-viewer__bar">
        <span className="superres-viewer__meta">
          {sizeText} · 显示 {Math.round(view.zoom * 100)}%
        </span>
        <div className="superres-viewer__controls">
          <button
            type="button"
            className="superres-viewer__ctrl"
            title="适配窗口"
            aria-label="适配窗口"
            onClick={fitToStage}
          >
            <FitIcon />
          </button>
          <button
            type="button"
            className="superres-viewer__ctrl"
            title="缩小"
            aria-label="缩小"
            onClick={() => zoomBy(1 / 1.25)}
          >
            <ZoomOutIcon />
          </button>
          <button
            type="button"
            className="superres-viewer__ctrl"
            title="放大"
            aria-label="放大"
            onClick={() => zoomBy(1.25)}
          >
            <ZoomInIcon />
          </button>
          <button
            type="button"
            className="superres-viewer__ctrl superres-viewer__ctrl--text"
            title="实际像素 1:1"
            aria-label="实际像素"
            onClick={zoomToActual}
          >
            1:1
          </button>
        </div>
      </div>
    </div>
  );
}
