/**
 * 直方图面板（任务 M4.2/M4.2.1/M4.3/M4.3.2）：两 tab——RGB·明度（默认）/ 色阶，
 * 面板内切换不占左栏。Canvas 2D 绘制，Apple 风格平滑填充曲线 + screen 通道叠加，
 * 色值全部经 CSS token 读取（零硬编码色值），主题切换 / resize / 数据变化自动重绘。
 * 饱和度分布已迁入左栏「饱和度」工具（SaturationPanel）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "../store";
import { computeHistogram } from "../histogram";
import { clearLevelsPreview } from "../imageSource";
import { luma } from "../../../core/imaging/color";
import { PanelInfoButton } from "./PanelInfo";
import {
  setupDrawCtx,
  smoothBins,
  traceCurve,
  drawXAxis,
  drawYTitle,
} from "./chartUtils";

/* ---- token 读取 helper ---- */

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 直方图分段开关样式 class（tab 栏复用） */
const SEG_CLASS = "lab-hist__seg";

const HIST_INFO_LINES = [
  "RGB/明度：R/G/B 三通道叠加 + 明度线，线性/对数刻度切换；对数便于检查暗部细节",
  "色阶：点「拾取黑场」后在图上点暗部、点「拾取白场」后点亮部，全图自动重映射到该区间；点「重置」恢复原图",
  "死黑/死白占比 > 1% 时红色警告（裁切风险）；饱和度分布见左栏「饱和度」工具",
];

/* ---- 小图标内联 SVG ---- */

function RgbIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="7" cy="7" r="3" fill="none" /><circle cx="17" cy="7" r="3" fill="none" /><circle cx="12" cy="17" r="3" fill="none" /></svg>); }
function LumaIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>); }

/* ================================================================
 *  RGB·明度 tab 绘制（Apple 风格：screen 混合平滑填充曲线 + 明度线）
 * ================================================================ */

function useRgbDraw(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  hist: ReturnType<typeof computeHistogram>,
  mode: "rgb" | "luma",
  scale: "linear" | "log",
  redrawKey: number,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas || !hist) return;
    const dc = setupDrawCtx(canvas);
    if (!dc) return;

    const { ctx, w, plotH, plotY } = dc;
    const baseY = plotY + plotH;
    const histR = readToken("--lab-hist-r") || "rgb(216 64 52 / 50%)";
    const histG = readToken("--lab-hist-g") || "rgb(64 160 88 / 50%)";
    const histB = readToken("--lab-hist-b") || "rgb(64 128 224 / 50%)";
    const text1 = readToken("--text-1") || "#ffffff";

    const tx = (bins: Uint32Array): Float64Array => {
      const a = new Float64Array(256);
      if (scale === "log") for (let i = 0; i < 256; i++) a[i] = Math.log10(1 + bins[i]);
      else for (let i = 0; i < 256; i++) a[i] = bins[i];
      return a;
    };
    const tr = tx(hist.r);
    const tg = tx(hist.g);
    const tb = tx(hist.b);
    const tl = tx(hist.l);

    if (mode === "rgb") {
      const trs = smoothBins(tr);
      const tgs = smoothBins(tg);
      const tbs = smoothBins(tb);
      const tls = smoothBins(tl);
      const jointMax = Math.max(1, ...trs, ...tgs, ...tbs, ...tls);

      // screen 混合：R/G/B 半透明填充曲线，重叠处自然趋亮趋白（Apple 感）
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = histR;
      traceCurve(ctx, trs, w, baseY, plotH, jointMax, true);
      ctx.fillStyle = histG;
      traceCurve(ctx, tgs, w, baseY, plotH, jointMax, true);
      ctx.fillStyle = histB;
      traceCurve(ctx, tbs, w, baseY, plotH, jointMax, true);
      ctx.globalCompositeOperation = "source-over";

      // 明度线（--text-1，1.5px，平滑折线）
      ctx.strokeStyle = text1;
      ctx.lineWidth = 1.5;
      traceCurve(ctx, tls, w, baseY, plotH, jointMax, false);
    } else {
      const tls = smoothBins(tl);
      const lumaMax = Math.max(1, ...tls);
      ctx.fillStyle = dc.text3;
      ctx.globalAlpha = 0.7;
      traceCurve(ctx, tls, w, baseY, plotH, lumaMax, true);
      ctx.globalAlpha = 1;
    }

    drawXAxis(dc, [0, 64, 128, 192, 255], "像素值 · 明度");
    drawYTitle(dc, "像素数");
  }, [hist, mode, scale, redrawKey, canvasRef, active]);
}

/* ================================================================
 *  色阶 tab 绘制（Apple 风格平滑填充 + 黑/白场标线保留）
 * ================================================================ */

function useLevelsDraw(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  hist: ReturnType<typeof computeHistogram>,
  levels: { black: number; white: number } | null,
  redrawKey: number,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas || !hist) return;
    const dc = setupDrawCtx(canvas);
    if (!dc) return;

    const { ctx, w, plotH, plotY, text3 } = dc;
    const baseY = plotY + plotH;
    const accent = readToken("--accent") || "#6366f1";
    const text1 = readToken("--text-1") || "#1a1a1e";

    // 输入 L 直方图平滑填充
    const tl = new Float64Array(256);
    for (let i = 0; i < 256; i++) tl[i] = hist.l[i];
    const tls = smoothBins(tl);
    const lumaMax = Math.max(1, ...tls);

    ctx.fillStyle = text3;
    ctx.globalAlpha = 0.7;
    traceCurve(ctx, tls, w, baseY, plotH, lumaMax, true);
    ctx.globalAlpha = 1;

    // 黑/白场标线（保留原样）
    if (levels) {
      const drawMarker = (v: number, color: string, label: string) => {
        const x = (v / 255) * w;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, plotY);
        ctx.lineTo(Math.round(x) + 0.5, plotY + plotH);
        ctx.stroke();
        ctx.fillStyle = text3;
        ctx.font = dc.axisFont;
        ctx.textAlign = "center";
        ctx.fillText(label, x, plotY + 11);
      };
      drawMarker(levels.black, text1, "B");
      drawMarker(levels.white, accent, "W");
    }

    drawXAxis(dc, [0, 64, 128, 192, 255], "输入色阶（明度 L）");
    drawYTitle(dc, "像素数");
  }, [hist, levels, redrawKey, canvasRef, active]);
}

/* ================================================================
 *  主组件
 * ================================================================ */

export function HistogramPanel() {
  const image = useLabStore((s) => s.image);
  const pointer = useLabStore((s) => s.pointer);
  const levels = useLabStore((s) => s.levels);
  const levelsPick = useLabStore((s) => s.levelsPick);
  const setLevels = useLabStore((s) => s.setLevels);
  const setLevelsPick = useLabStore((s) => s.setLevelsPick);

  const [tab, setTab] = useState<"rgb" | "levels">("rgb");

  // 色阶 tab 光标竖线：指针在图上时取 Rec.601 luma，图外/null 时不画
  const hoverLuma: number | null =
    tab === "levels" && pointer
      ? Math.round(luma(pointer.r, pointer.g, pointer.b))
      : null;
  // RGB tab 专属状态
  const [mode, setMode] = useState<"rgb" | "luma">("rgb");
  const [scale, setScale] = useState<"linear" | "log">("linear");

  // 两个 tab 各用独立 canvas ref + container ref（条件渲染，切换时重新 mount）
  const rgbCanvasRef = useRef<HTMLCanvasElement>(null);
  const rgbContainerRef = useRef<HTMLDivElement>(null);
  const levelsCanvasRef = useRef<HTMLCanvasElement>(null);
  const levelsContainerRef = useRef<HTMLDivElement>(null);

  const [redrawKey, setRedrawKey] = useState(0);

  const hist = useMemo(() => computeHistogram(), [image?.name, image?.width, image?.height, image?.url]); // eslint-disable-line

  // 各 tab 的绘制 hook（active 参数确保 tab 切换时新 canvas 即挂即绘）
  useRgbDraw(rgbCanvasRef, hist, mode, scale, redrawKey, tab === "rgb");
  useLevelsDraw(levelsCanvasRef, hist, levels, redrawKey, tab === "levels");

  const forceRedraw = useCallback(() => setRedrawKey((k) => k + 1), []);

  // 主题切换 → 全局重绘
  useEffect(() => {
    const observer = new MutationObserver(forceRedraw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [forceRedraw]);

  // ResizeObserver：面板宽度变化 / 容器 resize → 重绘
  useEffect(() => {
    const el = document.getElementById("lab-output-wrapper");
    if (!el) return;
    const ro = new ResizeObserver(forceRedraw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [forceRedraw]);

  // 切换 tab 时清除拾取态
  const onTabClick = (newTab: "rgb" | "levels") => {
    if (levelsPick) setLevelsPick(null);
    setTab(newTab);
  };

  // 色阶按钮：点击拾取（再次点击已激活的 = 取消）
  const onPickBtn = (pick: "black" | "white") => {
    if (levelsPick === pick) {
      setLevelsPick(null);
    } else {
      setLevelsPick(pick);
    }
  };

  // 重置色阶
  const onResetLevels = () => {
    setLevels(null);
    setLevelsPick(null);
    clearLevelsPreview();
  };

  // 无图状态：显示 tab 栏 + 占位文案
  if (!image) {
    return (
      <>
        <header className="lab-panel__header">
          <h1 className="lab-panel__name">直方图</h1>
          <PanelInfoButton lines={HIST_INFO_LINES} />
        </header>
        {/* tab 栏可渲染，内容占位 */}
        <div className="lab-hist__tabs">
          <button type="button" className={`${SEG_CLASS}${tab === "rgb" ? " is-active" : ""}`} onClick={() => onTabClick("rgb")}>RGB·明度</button>
          <button type="button" className={`${SEG_CLASS}${tab === "levels" ? " is-active" : ""}`} onClick={() => onTabClick("levels")}>色阶</button>
        </div>
        <div className="lab-panel__card">打开图像后，这里显示该工具的分析结果</div>
      </>
    );
  }

  const dbPct = (hist ? (hist.deadBlack * 100).toFixed(1) : "—");
  const dwPct = (hist ? (hist.deadWhite * 100).toFixed(1) : "—");
  const dbWarn = hist && hist.deadBlack > 0.01;
  const dwWarn = hist && hist.deadWhite > 0.01;

  return (
    <>
      <header className="lab-panel__header">
        <h1 className="lab-panel__name">直方图</h1>
        <PanelInfoButton lines={HIST_INFO_LINES} />
      </header>

      {/* tab 栏（两枚） */}
      <div className="lab-hist__tabs">
        <button type="button" className={`${SEG_CLASS}${tab === "rgb" ? " is-active" : ""}`} onClick={() => onTabClick("rgb")}>RGB·明度</button>
        <button type="button" className={`${SEG_CLASS}${tab === "levels" ? " is-active" : ""}`} onClick={() => onTabClick("levels")}>色阶</button>
      </div>

      <div className="lab-panel__card">
          {/* ---- RGB·明度 tab ---- */}
          {tab === "rgb" && (
            <>
              <div ref={rgbContainerRef} className="lab-hist__canvas-wrap">
                <canvas ref={rgbCanvasRef} className="lab-hist__canvas" />
              </div>

              <div className="lab-hist__row">
                <div className="lab-hist__segs">
                  <button type="button" className={`${SEG_CLASS}${mode === "rgb" ? " is-active" : ""}`} title="通道分合" aria-pressed={mode === "rgb"} onClick={() => setMode("rgb")}>
                    <RgbIcon /><span>RGB</span>
                  </button>
                  <button type="button" className={`${SEG_CLASS}${mode === "luma" ? " is-active" : ""}`} title="明度" aria-pressed={mode === "luma"} onClick={() => setMode("luma")}>
                    <LumaIcon /><span>明度</span>
                  </button>
                </div>
                <div className="lab-hist__segs">
                  <button type="button" className={`${SEG_CLASS}${scale === "linear" ? " is-active" : ""}`} title="线性刻度" aria-pressed={scale === "linear"} onClick={() => setScale("linear")}>
                    线性
                  </button>
                  <button type="button" className={`${SEG_CLASS}${scale === "log" ? " is-active" : ""}`} title="对数刻度 · 便于观察暗部" aria-pressed={scale === "log"} onClick={() => setScale("log")}>
                    对数
                  </button>
                </div>
              </div>

              <div className="lab-hist__readout">
                <span className={`lab-hist__chip${dbWarn ? " lab-hist__chip--warn" : ""}`}>
                  <span className="lab-hist__dot" />
                  死黑 <span className="lab-hist__value">{dbPct}%</span>
                </span>
                <span className={`lab-hist__chip${dwWarn ? " lab-hist__chip--warn" : ""}`}>
                  <span className="lab-hist__dot" />
                  死白 <span className="lab-hist__value">{dwPct}%</span>
                </span>
              </div>
            </>
          )}

          {/* ---- 色阶 tab ---- */}
          {tab === "levels" && (
            <>
              <div ref={levelsContainerRef} className="lab-hist__canvas-wrap">
                <canvas ref={levelsCanvasRef} className="lab-hist__canvas" />
                {hoverLuma !== null && (
                  <div
                    className="lab-hist__cursor-line"
                    style={{ left: `${(hoverLuma / 255) * 100}%` }}
                    aria-hidden="true"
                  />
                )}
              </div>

              <div className="lab-hist__row">
                <div className="lab-hist__segs">
                  <button
                    type="button"
                    className={`lab-levels__btn${levelsPick === "black" ? " is-active" : ""}`}
                    onClick={() => onPickBtn("black")}
                  >
                    拾取黑场
                  </button>
                  <button
                    type="button"
                    className={`lab-levels__btn${levelsPick === "white" ? " is-active" : ""}`}
                    onClick={() => onPickBtn("white")}
                  >
                    拾取白场
                  </button>
                </div>
                <button
                  type="button"
                  className="lab-levels__btn"
                  disabled={levels === null}
                  onClick={onResetLevels}
                >
                  重置
                </button>
              </div>

              <div className="lab-hist__readout">
                <span className="lab-hist__chip">
                  <span className="lab-hist__dot" style={{ background: "var(--text-1)" }} />
                  B <span className="lab-hist__value">{levels ? levels.black : "—"}</span>
                </span>
                <span className="lab-hist__chip">
                  <span className="lab-hist__dot" style={{ background: "var(--accent)" }} />
                  W <span className="lab-hist__value">{levels ? levels.white : "—"}</span>
                </span>
              </div>
            </>
          )}
        </div>
    </>
  );
}
