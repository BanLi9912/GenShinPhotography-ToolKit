/**
 * 底部色彩旅程小窗（任务 M4.8）：色带 + 通道曲线 + 双向联动。
 * M4.9.1 追加：头部 ⓘ 图例说明——事件行短句化（完整含义移入说明窗），
 * 说明窗内含 HSL 曲线圆点/三角等图例含义。
 * 可见条件：tool==="stroke" && activeStroke 可见且 samples 可用。
 * 进出动画 200ms 升起 / 150ms 下移收起，不进 reduced-motion 抑制。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "../store";
import { computeStrokeEvents, describeStrokeEvents, findLumaExtrema } from "../strokeAnalysis";
import { traceCurve, smoothBins } from "./chartUtils";
import { PanelInfoButton } from "./PanelInfo";

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const CHANNEL_LABELS: Record<string, string> = { L: "明度", S: "饱和度", H: "色相", R: "红", G: "绿", B: "蓝" };

/** 抽屉图例说明（M4.9.1）：事件行只显示短句，完整含义与曲线图例集中在这里 */
const DRAWER_INFO = [
  "通道图例：灰线 = 明度 L，主题色线 = 饱和度 S，彩虹线 = 色相 H；RGB 空间为红 / 绿 / 蓝通道。",
  "曲线圆点 = 事件点（HSL 空间，仅对应通道开启时显示）：灰圆 = 明度跃迁，彩虹圆 = 色相跳变，主题色圆 = 饱和度峰值。",
  "L 通道开启时另标明度剖面：两端「起 / 终」圆点；空心三角 = 峰谷（尖朝上 = 峰，尖朝下 = 谷）。",
  "事件行短句含义：明度骤降 / 骤升 = 全场最大明暗转折；色相跳变 = 色彩转向最明显处；饱和度峰值 = 全场最艳。",
];

export function StrokeDrawer({ visible }: { visible: boolean }) {
  const strokes = useLabStore((s) => s.strokes);
  const activeId = useLabStore((s) => s.activeStrokeId);
  const hoverT = useLabStore((s) => s.strokeHoverT);
  const setHoverT = useLabStore((s) => s.setStrokeHoverT);

  const stripRef = useRef<HTMLCanvasElement>(null);
  const curveRef = useRef<HTMLCanvasElement>(null);

  const [space, setSpace] = useState<"hsl" | "rgb">("hsl");
  const [channels, setChannels] = useState<Record<string, boolean>>({ L: true, S: true, H: true, R: true, G: true, B: true });

  // 进出动画状态机
  const [closing, setClosing] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (visible) { setMounted(true); setClosing(false); }
    else if (mounted) {
      setClosing(true);
      const t = setTimeout(() => { setMounted(false); setClosing(false); }, 150);
      return () => clearTimeout(t);
    }
  }, [visible, mounted]);

  const active = strokes.find((l) => l.id === activeId);
  // 稳定化 samples 引用（oxlint exhaustive-deps）：active 不变时复用同一数组，避免空态每次新建
  const samples = useMemo(() => (active?.visible ? active.samples : []), [active]);
  const events = computeStrokeEvents(samples);
  const eventRows = events ? describeStrokeEvents(samples, events) : [];

  /* ---- 色带 ---- */
  const drawStrip = useCallback(() => {
    const canvas = stripRef.current;
    if (!canvas || samples.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (w === 0 || h === 0) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = samples.length;
    for (let x = 0; x < w; x++) {
      const idx = Math.min(n - 1, Math.floor((x / w) * n));
      const s = samples[idx];
      ctx.fillStyle = `rgb(${s.r},${s.g},${s.b})`;
      ctx.fillRect(x, 0, 1, h);
    }
  }, [samples]);

  /* ---- 通道曲线 ---- */
  const drawCurves = useCallback(() => {
    const canvas = curveRef.current;
    if (!canvas || samples.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    if (W === 0 || H === 0) return;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padL = 8, padR = 8, padT = 10, padB = 10;
    const pw = W - padL - padR;
    const ph = H - padT - padB;
    const lineClr = readToken("--line") || "rgba(255,255,255,0.14)";
    const accent = readToken("--accent") || "#6366f1";
    const text2 = readToken("--text-2") || "#a3a3a3";
    const text3 = readToken("--text-3") || "#8e8e96";
    const histR = readToken("--lab-hist-r") || "rgb(216 64 52)";
    const histG = readToken("--lab-hist-g") || "rgb(64 160 88)";
    const histB = readToken("--lab-hist-b") || "rgb(64 128 224)";

    // 网格
    ctx.strokeStyle = lineClr;
    ctx.lineWidth = 0.5;
    for (const frac of [0, 0.5, 1]) {
      const y = padT + ph * (1 - frac);
      ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + 0.5); ctx.lineTo(W - padR, Math.round(y) + 0.5); ctx.stroke();
    }

    // 绘制各通道
    const n = samples.length;
    const drawChan = (key: string, getV: (s: typeof samples[0]) => number, norm: number, color: string, curved: boolean) => {
      if (!channels[key]) return;
      const vals = new Float64Array(n);
      for (let i = 0; i < n; i++) vals[i] = samples[i] ? getV(samples[i]) / norm : 0;
      const smoothed = curved ? smoothBins(vals) : vals;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, pw, ph);
      ctx.clip();
      ctx.translate(padL, padT);
      traceCurve(ctx, smoothed, pw, ph, ph, 1, false);
      ctx.restore();
    };

    // H 手绘分段（仅 HSL）
    if (space === "hsl" && channels["H"]) {
      ctx.save();
      ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
      for (let i = 0; i < n - 1; i++) {
        const s0 = samples[i], s1 = samples[i + 1];
        if (!s0 || !s1) continue;
        const x0 = padL + (i / (n - 1)) * pw;
        const x1 = padL + ((i + 1) / (n - 1)) * pw;
        const y0 = padT + ph * (1 - s0.h / 360);
        const y1 = padT + ph * (1 - s1.h / 360);
        ctx.strokeStyle = `hsl(${Math.round(s0.h)},80%,48%)`; // 内容色
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      ctx.restore();
    }

    if (space === "hsl") {
      drawChan("L", (s) => s.l, 100, text2, true);
      drawChan("S", (s) => s.s, 100, accent, true);
    }
    if (space === "rgb") {
      drawChan("R", (s) => s.r, 255, histR, true);
      drawChan("G", (s) => s.g, 255, histG, true);
      drawChan("B", (s) => s.b, 255, histB, true);
    }

    // 事件点 + 明度剖面高亮（仅 HSL 空间，任务 M4.9；hover 参考线之前画）
    if (space === "hsl") {
      const bgPanel = readToken("--bg-panel") || "transparent";
      const ev = computeStrokeEvents(samples);

      // 曲线经 smoothBins 平滑后绘制，标注必须落在平滑后的曲线坐标上（M4.9 修正）：
      // 与 traceCurve 完全一致——x=(i+0.5)/n·pw、y=ph-v·(ph-4)
      const rawL = new Float64Array(n);
      const rawS = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        rawL[i] = samples[i].l / 100;
        rawS[i] = samples[i].s / 100;
      }
      const smL = smoothBins(rawL);
      const smS = smoothBins(rawS);
      const curvePt = (vals: Float64Array, idx: number) => ({
        x: padL + ((idx + 0.5) / n) * pw,
        y: padT + ph - vals[idx] * (ph - 4),
      });

      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, pw, ph);
      ctx.clip();

      // 曲线事件点（4.2.2）：仅对应通道开启时；H/S/L 事件口径来自事件检测
      if (ev) {
        const mark = (pt: { x: number; y: number }, color: string) => {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = bgPanel;
          ctx.stroke();
        };
        if (channels["L"]) mark(curvePt(smL, ev.li), text2);
        // H 曲线为逐段直线（未平滑），事件点用与曲线相同的线性坐标 + 原始 h
        if (channels["H"]) mark(
          { x: padL + (ev.hi / (n - 1)) * pw, y: padT + ph * (1 - samples[ev.hi].h / 360) },
          `hsl(${Math.round(samples[ev.hi].h)},80%,48%)`, // 内容色
        );
        if (channels["S"]) mark(curvePt(smS, ev.si), accent);
      }

      // 明度剖面高亮（4.2.3）：起终点实心圆 + 峰谷空心三角（仅 L 通道开）
      if (channels["L"]) {
        const start = curvePt(smL, 0);
        const end = curvePt(smL, n - 1);

        ctx.fillStyle = text2;
        ctx.beginPath(); ctx.arc(start.x, start.y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(end.x, end.y, 3, 0, Math.PI * 2); ctx.fill();

        // 「起」在点上方、「终」在点下方，防重叠
        ctx.fillStyle = text3;
        ctx.font = "9px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("起", start.x, start.y - 10);
        ctx.fillText("终", end.x, end.y + 11);

        // 峰谷：峰=尖朝上空三角、谷=尖朝下倒三角，外接圆半径 4
        const extrema = findLumaExtrema(samples);
        ctx.strokeStyle = text2;
        ctx.lineWidth = 1.2;
        const tri = (x: number, y: number, up: boolean) => {
          const rT = 4;
          const s3 = (Math.sqrt(3) / 2) * rT;
          ctx.beginPath();
          if (up) {
            ctx.moveTo(x, y - rT);
            ctx.lineTo(x - s3, y + rT / 2);
            ctx.lineTo(x + s3, y + rT / 2);
          } else {
            ctx.moveTo(x, y + rT);
            ctx.lineTo(x - s3, y - rT / 2);
            ctx.lineTo(x + s3, y - rT / 2);
          }
          ctx.closePath();
          ctx.stroke();
        };
        for (const p of extrema.peaks) { const pt = curvePt(smL, p); tri(pt.x, pt.y, true); }
        for (const v of extrema.valleys) { const pt = curvePt(smL, v); tri(pt.x, pt.y, false); }
      }

      ctx.restore();
    }

    // hover 参考线 + 通道圆点
    if (hoverT != null && hoverT >= 0 && hoverT <= 1) {
      const idx = Math.round(hoverT * (n - 1));
      const s = samples[idx];
      if (s) {
        const hx = padL + (idx / (n - 1)) * pw;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, padT); ctx.lineTo(Math.round(hx) + 0.5, padT + ph); ctx.stroke();
        // 通道圆点（仅当前色彩空间）
        const activeKeys = space === "hsl" ? ["L", "S", "H"] : ["R", "G", "B"];
        const dotColors: Record<string, string> = {
          L: text2, S: accent, H: `hsl(${Math.round(s.h)},80%,48%)`, // 内容色
          R: histR, G: histG, B: histB,
        };
        const norms: Record<string, number> = { L: 100, S: 100, H: 360, R: 255, G: 255, B: 255 };
        for (const k of activeKeys) {
          if (!channels[k]) continue;
          const val = k === "L" ? s.l : k === "S" ? s.s : k === "H" ? s.h : k === "R" ? s.r : k === "G" ? s.g : s.b;
          const dy = padT + ph * (1 - val / norms[k]);
          ctx.fillStyle = dotColors[k];
          ctx.beginPath(); ctx.arc(hx, dy, 2.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }, [samples, channels, space, hoverT]);

  useEffect(() => { drawStrip(); }, [drawStrip]);
  useEffect(() => { drawCurves(); }, [drawCurves]);

  // 显隐切换时 canvas 重挂，useEffect 里可能还是 0×0，拉一帧后再画
  useEffect(() => {
    if (!mounted) return;
    const raf = requestAnimationFrame(() => { drawStrip(); drawCurves(); });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  // 主题重绘
  useEffect(() => {
    const observer = new MutationObserver(() => { drawStrip(); drawCurves(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [drawStrip, drawCurves]);

  // resize 重绘
  useEffect(() => {
    const el = document.querySelector(".lab-stroke-drawer");
    if (!el) return;
    const ro = new ResizeObserver(() => { drawStrip(); drawCurves(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [drawStrip, drawCurves]);

  if (!mounted) return null;

  const activeKeys = space === "hsl" ? ["L", "S", "H"] : ["R", "G", "B"];
  const channelColors: Record<string, string> = {
    L: "var(--text-2)", S: "var(--accent)", H: "hsl(0,80%,48%)",
    R: "var(--lab-hist-r)", G: "var(--lab-hist-g)", B: "var(--lab-hist-b)",
  };

  return (
    <div className={`lab-stroke-drawer${closing ? " is-closing" : ""}`} aria-label="色彩旅程">
      <div className="lab-stroke-drawer__inner">
        <div className="lab-stroke-drawer__header">
          <span className="lab-stroke-drawer__title">色彩旅程</span>
          <div className="lab-hist__segs">
            <button type="button" className={`lab-hist__seg${space === "hsl" ? " is-active" : ""}`}
              onClick={() => setSpace("hsl")}>HSL</button>
            <button type="button" className={`lab-hist__seg${space === "rgb" ? " is-active" : ""}`}
              onClick={() => setSpace("rgb")}>RGB</button>
          </div>
          <div className="lab-stroke-drawer__chips">
            {activeKeys.map((k) => (
              <button key={k} type="button"
                className={`lab-hist__chip${channels[k] ? " is-active" : ""}`}
                onClick={() => setChannels((c) => ({ ...c, [k]: !c[k] }))}>
                <span className="lab-hist__dot" style={{
                  background: k === "H" ? "conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)" : channelColors[k],
                  borderRadius: k === "H" ? "50%" : undefined,
                }} />
                {CHANNEL_LABELS[k]}
              </button>
            ))}
          </div>
          <PanelInfoButton lines={DRAWER_INFO} />
        </div>
        <canvas ref={stripRef} className="lab-stroke-drawer__strip" />
        {events && eventRows.length > 0 && (
          <div className="lab-stroke-drawer__events">
            {eventRows.map((r) => (
              <span key={r.kind} className="lab-stroke-drawer__event">
                <i style={{
                  background:
                    r.kind === "luma-jump" ? "var(--text-2)" :
                    r.kind === "sat-peak" ? "var(--accent)" :
                    `hsl(${Math.round(samples[events.hi].h)},80%,48%)`, // 内容色
                }} />
                {r.short}
              </span>
            ))}
          </div>
        )}
        <canvas
          ref={curveRef}
          className="lab-stroke-drawer__curve"
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const padL = 8, padR = 8;
            const pw = rect.width - padL - padR;
            const t = Math.max(0, Math.min(1, (e.clientX - rect.left - padL) / pw));
            setHoverT(t);
          }}
          onPointerLeave={() => setHoverT(null)}
        />
      </div>
    </div>
  );
}
