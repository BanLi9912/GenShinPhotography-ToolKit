import { useCallback, useEffect, useRef, useState } from "react";
import { getOverlayImageUrl, openImageFile, openSampleImage, readLuma, readPixel, setLevelsPreview } from "../imageSource";
import { MAX_ZOOM, MIN_ZOOM, useLabStore } from "../store";
import type { OverlayTool } from "../store";
import { sampleStroke } from "../strokeAnalysis";
import { StrokeOverlay } from "./StrokeOverlay";

/** 覆盖源标签映射 */
const OVERLAY_LABEL: Record<OverlayTool, string> = {
  dotgain: "Dot Gain 20% 校样",
  "sat-check": "饱和度检查",
  "sat-heat": "饱和热力",
  falsecolor: "假彩色",
};

/** 滚轮缩放系数（与 M1 画布一致） */
const WHEEL_ZOOM_FACTOR = 0.002;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** 点到线段最近距离 */
function pointToSegmentDist(p: {x:number;y:number}, a: {x:number;y:number}, b: {x:number;y:number}): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x)*dx + (p.y - a.y)*dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t*dx), p.y - (a.y + t*dy));
}

function minDistToLine(pts: {x:number;y:number}[], p: {x:number;y:number}): number {
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointToSegmentDist(p, pts[i], pts[i+1]);
    if (d < min) min = d;
  }
  return min;
}

/** 适配窗口图标（四角展开） */
function FitIcon() {
  return (
    <svg
      width="16"
      height="16"
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

/**
 * 图像视口（开发文档-M4 §2.5）：滚轮缩放 0.25–4x（光标锚定）· 拖拽平移 ·
 * 适配 / 1:1 · zoom ≥ 1 像素 crisp（GPU 变换 + pixelated，§6.4 图像不失焦）。
 * 光标读数（图像像素坐标 + RGB/HSL）写入 store，状态栏实时显示。
 * 未加载图像时显示空状态引导卡（§6.4 不允许大白屏）。
 */
export function LabViewport({ panelRight, panelResizing }: { panelRight?: number; panelResizing?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const image = useLabStore((s) => s.image);
  const viewport = useLabStore((s) => s.viewport);
  const levelsPick = useLabStore((s) => s.levelsPick);
  const overlay = useLabStore((s) => s.overlay);
  const setOverlay = useLabStore((s) => s.setOverlay);
  const [panning, setPanning] = useState(false);

  // stroke 模式
  const tool = useLabStore((s) => s.tool);
  const startStroke = useLabStore((s) => s.startStroke);
  const appendStrokePoint = useLabStore((s) => s.appendStrokePoint);
  const finishStroke = useLabStore((s) => s.finishStroke);
  const translateStroke = useLabStore((s) => s.translateStroke);
  const updateStroke = useLabStore((s) => s.updateStroke);
  const setActiveStroke = useLabStore((s) => s.setActiveStroke);
  const strokeRef = useRef<{ lastX: number; lastY: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  // 覆盖层状态
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  const [overlayOn, setOverlayOn] = useState(false);
  const overlayUrlRef = useRef(overlayUrl);
  overlayUrlRef.current = overlayUrl;

  // 换图 → 卸载覆盖层
  useEffect(() => { setOverlayUrl(null); setOverlayOn(false); }, [image?.url]);

  // 覆盖开关驱动
  useEffect(() => {
    if (!overlay) { setOverlayOn(false); return; }
    let cancelled = false;
    void getOverlayImageUrl(overlay).then((url) => {
      if (cancelled || !url) return;
      if (url === overlayUrlRef.current) setOverlayOn(true);
      else setOverlayUrl(url);
    });
    return () => { cancelled = true; };
  }, [overlay]);

  /** 适配窗口：整图可见并居中（新图打开后自动执行一次，§4.1 默认"适配"） */
  const fitToContainer = useCallback(() => {
    const el = containerRef.current;
    const s = useLabStore.getState();
    if (!el || !s.image) return;
    const img = s.image;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return;
    const rightInset = s.panel.collapsed ? 12 : s.panel.width + 24;
    const leftInset = 12;
    // 色彩旅程抽屉可见时留出底部空间
    const active = s.strokes.find(l => l.id === s.activeStrokeId);
    const drawerVis = s.tool === "stroke" && !!(active?.visible && active.samples.length > 1);
    const drawerH = drawerVis ? Math.min(h * 0.4, 320) : 0;
    const bottomInset = drawerVis ? 24 + drawerH : 0;
    const availW = w - leftInset - rightInset;
    const availH = h - bottomInset;
    const zoom = clampZoom(Math.min(availW / img.width, availH / img.height));
    useLabStore.getState().setViewport({
      x: leftInset + (availW - img.width * zoom) / 2,
      y: (availH - img.height * zoom) / 2,
      zoom,
    });
  }, []);

  const imageUrl = image?.url;
  useEffect(() => {
    if (imageUrl) fitToContainer();
  }, [imageUrl, fitToContainer]);

  /** 1:1 实际像素：以视口中心为锚切换 */
  const zoomToActual = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const s = useLabStore.getState();
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const wx = (cx - s.viewport.x) / s.viewport.zoom;
    const wy = (cy - s.viewport.y) / s.viewport.zoom;
    s.setViewport({ x: cx - wx, y: cy - wy, zoom: 1 });
  }, []);

  // 滚轮缩放：以光标为锚点，缩放前后保持光标下的像素不动
  // （原生监听：React onWheel 为 passive，无法 preventDefault）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = useLabStore.getState();
      if (!s.image) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const oldZoom = s.viewport.zoom;
      const newZoom = clampZoom(
        oldZoom * Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR),
      );
      if (newZoom === oldZoom) return;
      const wx = (px - s.viewport.x) / oldZoom;
      const wy = (py - s.viewport.y) / oldZoom;
      s.setViewport({
        x: px - wx * newZoom,
        y: py - wy * newZoom,
        zoom: newZoom,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Esc 取消色阶拾取 / 划线取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const s = useLabStore.getState();
        if (s.strokeDraft) { s.cancelStroke(); return; }
        if (s.levelsPick) s.setLevelsPick(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // 空格临时平移
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.key === " ") { setSpaceHeld(true); e.preventDefault(); }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === " ") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  }, []);

  /** 光标读数：屏幕坐标 → 图像像素 → RGB/HSL（图外置 null，状态栏显示"—"） */
  const updatePointerReadout = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const s = useLabStore.getState();
      if (!s.image) return;
      const rect = el.getBoundingClientRect();
      const ix = Math.floor(
        (clientX - rect.left - s.viewport.x) / s.viewport.zoom,
      );
      const iy = Math.floor(
        (clientY - rect.top - s.viewport.y) / s.viewport.zoom,
      );
      const px = readPixel(ix, iy);
      s.setPointer(px ? { x: ix, y: iy, ...px } : null);
    },
    [],
  );

  // 拖拽平移/划线：指针捕获，移出视口再松手也能收尾
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const s = useLabStore.getState();
    if (!s.image) return;
    if (s.levelsPick) return; // 拾取模式：不启动 pan

    // stroke 模式：划线 / 移线
    if (s.tool === "stroke" && !spaceHeld) {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ix = (e.clientX - rect.left - s.viewport.x) / s.viewport.zoom;
      const iy = (e.clientY - rect.top - s.viewport.y) / s.viewport.zoom;
      const cx = Math.max(0, Math.min(s.image.width - 1, Math.round(ix)));
      const cy = Math.max(0, Math.min(s.image.height - 1, Math.round(iy)));
      const pt = { x: cx, y: cy };

      // 命中检测（active 优先）
      const threshold = 8 / s.viewport.zoom;
      let hitId: number | null = null;
      const active = s.strokes.find(l => l.id === s.activeStrokeId);
      if (active && active.visible && minDistToLine(active.points, pt) < threshold) hitId = active.id;
      if (hitId === null) {
        for (const l of s.strokes) {
          if (!l.visible || l.id === s.activeStrokeId) continue;
          if (minDistToLine(l.points, pt) < threshold) { hitId = l.id; break; }
        }
      }

      if (hitId !== null) {
        setActiveStroke(hitId);
        strokeRef.current = { lastX: pt.x, lastY: pt.y };
      } else {
        startStroke(pt);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: s.viewport.x,
      originY: s.viewport.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan && e.pointerId === pan.pointerId) {
      const s = useLabStore.getState();
      s.setViewport({
        x: pan.originX + (e.clientX - pan.startX),
        y: pan.originY + (e.clientY - pan.startY),
        zoom: s.viewport.zoom,
      });
      updatePointerReadout(e.clientX, e.clientY);
      return;
    }

    // stroke 模式交互
    const ss = useLabStore.getState();
    if (ss.tool === "stroke" && !pan) {
      if (!ss.image) { updatePointerReadout(e.clientX, e.clientY); return; }
      const el = containerRef.current;
      if (!el) { updatePointerReadout(e.clientX, e.clientY); return; }
      const rect = el.getBoundingClientRect();
      const ix = (e.clientX - rect.left - ss.viewport.x) / ss.viewport.zoom;
      const iy = (e.clientY - rect.top - ss.viewport.y) / ss.viewport.zoom;
      const cx = Math.max(0, Math.min(ss.image.width - 1, Math.round(ix)));
      const cy = Math.max(0, Math.min(ss.image.height - 1, Math.round(iy)));
      const pt = { x: cx, y: cy };

      if (ss.strokeDraft) {
        if (e.shiftKey && ss.strokeDraft.points.length > 0) {
          const first = ss.strokeDraft.points[0];
          useLabStore.setState(su => ({
            strokeDraft: su.strokeDraft ? { ...su.strokeDraft, points: [first, pt] } : null,
            strokes: su.strokes.map(l => l.id === ss.strokeDraft!.id ? { ...l, points: [first, pt] } : l),
          }));
        } else {
          appendStrokePoint(pt);
        }
      } else if (strokeRef.current) {
        const dx = pt.x - strokeRef.current.lastX;
        const dy = pt.y - strokeRef.current.lastY;
        if (dx !== 0 || dy !== 0) {
          translateStroke(ss.activeStrokeId!, dx, dy);
          strokeRef.current = { lastX: pt.x, lastY: pt.y };
        }
      } else if (ss.activeStrokeId != null) {
        const active = ss.strokes.find(l => l.id === ss.activeStrokeId);
        if (active && active.visible && active.samples.length > 1) {
          let minD = Infinity, minT = 0;
          const threshold = 14 / ss.viewport.zoom;
          for (let i = 0; i < active.samples.length; i++) {
            const d = Math.hypot(pt.x - active.samples[i].x, pt.y - active.samples[i].y);
            if (d < minD) { minD = d; minT = active.samples[i].t; }
          }
          const newT = minD < threshold ? minT : null;
          if (newT !== ss.strokeHoverT) {
            useLabStore.getState().setStrokeHoverT(newT);
          }
        }
      }
    }

    updatePointerReadout(e.clientX, e.clientY);
  };

  const endPan = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = useLabStore.getState();

    // stroke 模式结束
    if (s.tool === "stroke") {
      if (s.strokeDraft) {
        finishStroke();
        const st2 = useLabStore.getState();
        const line = st2.strokes.find(l => l.id === st2.activeStrokeId);
        if (line && line.points.length >= 2) {
          const r = sampleStroke(line.points, st2.strokeStep, st2.strokeWidth);
          if (r) updateStroke(line.id, { samples: r.samples, totalLen: r.totalLen });
        }
      } else if (strokeRef.current) {
        const st2 = useLabStore.getState();
        const line2 = st2.strokes.find(l => l.id === st2.activeStrokeId);
        if (line2 && line2.points.length >= 2) {
          const r = sampleStroke(line2.points, st2.strokeStep, st2.strokeWidth);
          if (r) updateStroke(line2.id, { samples: r.samples, totalLen: r.totalLen });
        }
        strokeRef.current = null;
      }
      panRef.current = null;
      setPanning(false);
      return;
    }

    // 拾取模式：点击取色（panRef 为 null 说明未启动 pan）
    if (s.levelsPick && !panRef.current) {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ix = Math.floor((e.clientX - rect.left - s.viewport.x) / s.viewport.zoom);
      const iy = Math.floor((e.clientY - rect.top - s.viewport.y) / s.viewport.zoom);
      const v = readLuma(ix, iy);
      if (v !== null) {
        const pick = s.levelsPick;
        const cur = s.levels ?? { black: 0, white: 255 };
        let black = cur.black;
        let white = cur.white;
        if (pick === "black") {
          black = v;
          if (black >= white) white = Math.min(255, black + 1);
        } else {
          white = v;
          if (white <= black) black = Math.max(0, white - 1);
        }
        s.setLevels({ black, white });
        s.setLevelsPick(null);
        setLevelsPreview(black, white);
      }
      return;
    }

    if (panRef.current?.pointerId !== e.pointerId) return;
    panRef.current = null;
    setPanning(false);
  };

  return (
    <div
      ref={containerRef}
      className={[
        "lab-viewport",
        image ? "has-image" : "",
        panning ? "is-panning" : "",
        levelsPick ? "is-picking" : "",
        tool === "stroke" && !spaceHeld ? "is-stroking" : "",
        spaceHeld ? "is-space-pan" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onPointerLeave={() => {
        if (!panRef.current) useLabStore.getState().setPointer(null);
      }}
    >
      {image ? (
        <>
          <img
            className="lab-viewport__img"
            src={image.url}
            alt={image.name}
            width={image.width}
            height={image.height}
            draggable={false}
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
              imageRendering: viewport.zoom >= 1 ? "pixelated" : "auto",
            }}
          />
          {overlayUrl && (
            <img
              className={`lab-viewport__img lab-viewport__overlay${overlayOn ? " is-on" : ""}`}
              src={overlayUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
              onLoad={() => setOverlayOn(true)}
              style={{
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
                imageRendering: viewport.zoom >= 1 ? "pixelated" : "auto",
              }}
            />
          )}
          {overlayUrl && overlay && (
            <div
              className={`lab-viewport__overlay-badge${overlayOn ? " is-on" : ""}`}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <span className="lab-viewport__overlay-dot" aria-hidden="true" />
              <span>{OVERLAY_LABEL[overlay]}</span>
              <button
                type="button"
                className="lab-viewport__overlay-close"
                title="关闭覆盖"
                aria-label="关闭覆盖"
                onClick={() => setOverlay(null)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          )}
          <StrokeOverlay />
          <div
            className={`lab-viewport__controls${panelResizing ? " is-resizing" : ""}`}
            style={{ right: panelRight ?? 12 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="lab-viewport__ctrl"
              title="适配窗口"
              aria-label="适配窗口"
              onClick={fitToContainer}
            >
              <FitIcon />
            </button>
            <button
              type="button"
              className="lab-viewport__ctrl lab-viewport__ctrl--text"
              title="实际像素（1:1）"
              aria-label="实际像素"
              onClick={zoomToActual}
            >
              1:1
            </button>
          </div>
        </>
      ) : (
        <section className="lab-empty">
          <div className="lab-empty__card">
            <p className="lab-empty__title">打开图像开始分析</p>
            <p className="lab-empty__hint">
              直方图 / 主色板 / 检查视图 / 划线取色，分析结果全部归右栏
            </p>
            <div className="lab-empty__actions">
              <button
                type="button"
                className="lab-empty__btn lab-empty__btn--primary"
                onClick={() => fileInputRef.current?.click()}
              >
                打开本地图片
              </button>
              <button
                type="button"
                className="lab-empty__btn"
                onClick={() => openSampleImage()}
              >
                加载示例图
              </button>
            </div>
            <p className="lab-empty__drop">也可以直接把图片拖进本窗口，或 Ctrl+V 粘贴</p>
          </div>
        </section>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openImageFile(file);
          e.target.value = ""; // 允许重复选择同一文件
        }}
      />
    </div>
  );
}
