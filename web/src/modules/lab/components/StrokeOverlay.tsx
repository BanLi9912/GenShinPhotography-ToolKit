/**
 * 划线叠加层（任务 M4.8）：视口内绝对定位 canvas，画所有可见线 + active 线 hover 标记。
 * pointer-events: none，不拦截视口交互。
 */
import { useCallback, useEffect, useRef } from "react";
import { useLabStore } from "../store";
import { selectStrokeKeyPoints } from "../strokeAnalysis";

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function StrokeOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewport = useLabStore((s) => s.viewport);
  const strokes = useLabStore((s) => s.strokes);
  const draft = useLabStore((s) => s.strokeDraft);
  const activeId = useLabStore((s) => s.activeStrokeId);
  const hoverT = useLabStore((s) => s.strokeHoverT);
  const tool = useLabStore((s) => s.tool);
  const strokeWidth = useLabStore((s) => s.strokeWidth);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w === 0 || h === 0) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (tool !== "stroke") return;

    const { x, y, zoom } = viewport;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * x, dpr * y);

    const drawLine = (pts: { x: number; y: number }[], color: string, isActive: boolean) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = (isActive ? 3 : 2) / zoom;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      // 端点圆点
      ctx.fillStyle = color;
      const r = (isActive ? 4 : 3) / zoom;
      for (const p of [pts[0], pts[pts.length - 1]]) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      }
    };

    for (const line of strokes) {
      if (!line.visible) continue;
      const isActive = line.id === activeId;
      if (line.asPoints && line.samples.length > 1) {
        // 取样点模式：代表性变化点
        const idx = selectStrokeKeyPoints(line.samples);
        if (idx.length === 0) { drawLine(line.points, line.color, isActive); continue; }
        const r = Math.max(strokeWidth / 2, 8 / zoom);
        for (const i of idx) {
          const s = line.samples[i];
          ctx.fillStyle = `rgb(${s.r},${s.g},${s.b})`;
          ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
          // 外圈暗影（内容色）
          ctx.strokeStyle = "rgba(0,0,0,0.35)";
          ctx.lineWidth = 1 / zoom;
          ctx.beginPath(); ctx.arc(s.x, s.y, r + 1.5 / zoom, 0, Math.PI * 2); ctx.stroke();
          // 内圈白环（内容色）
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = (isActive ? 3 : 2) / zoom;
          ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
        }
      } else {
        drawLine(line.points, line.color, isActive);
      }
    }
    if (draft && draft.points.length >= 2) {
      drawLine(draft.points, draft.color, true);
    }

    // hover 标记
    if (hoverT != null && activeId != null) {
      const active = strokes.find((l) => l.id === activeId);
      if (active && active.visible && active.samples.length > 1) {
        const idx = Math.round(hoverT * (active.samples.length - 1));
        const s = active.samples[idx];
        const accent = readToken("--accent") || "#6366f1";
        const r = 5 / zoom;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.2 / zoom;
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
        // 十字刻线
        const cross = 10 / zoom;
        ctx.beginPath(); ctx.moveTo(s.x - cross, s.y); ctx.lineTo(s.x + cross, s.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, s.y - cross); ctx.lineTo(s.x, s.y + cross); ctx.stroke();
      }
    }
  }, [viewport, strokes, draft, activeId, hoverT, tool, strokeWidth]);

  useEffect(() => { draw(); }, [draw]);

  // 主题 + resize 重绘
  useEffect(() => {
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [draw]);

  useEffect(() => {
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [draw]);

  return <canvas ref={canvasRef} className="lab-viewport__strokes" aria-hidden="true" />;
}
