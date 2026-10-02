/**
 * 饱和度工具面板（任务 M4.3.2 / M4.5 / M4.5.1）：面板 tab（检查/热力）
 * + S 直方图（仅检查 tab，标均值线+低/高饱和范围联动）+ 反向预览。
 * 去壳返回，外壳与翻页由 LabPanel 统一负责。
 * Canvas 2D 绘制，Apple 风格平滑填充曲线，色值全部经 CSS token 读取。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "../store";
import type { OverlayTool } from "../store";
import { computeSaturationHistogram } from "../histogram";
import { getOverlayImageUrl } from "../imageSource";
import { PanelInfoButton } from "./PanelInfo";
import {
  setupDrawCtx,
  smoothBins,
  traceCurve,
  drawXAxis,
  drawYTitle,
} from "./chartUtils";

const SAT_CHECK_INFO = [
  "PS「50% 纯灰图层 + 明度混合模式」基准：保持色相/饱和度，Rec.601 luma 归一到 50%，越界色按 hue-preserving 裁剪",
  "S 直方图标均值线；点「低饱和/高饱和」chip 在图上显示对应范围（S≤20 / S≥80）",
  "「覆盖到画面」：检查视图叠加到图像视口，与其他覆盖互斥；面板下方预览与画布相反的状态",
];
const SAT_HEAT_INFO = [
  "仅由饱和度 S 映射：低饱和灰 → 橙 → 高饱和红；叠层 65% 混合，不糊图",
  "「覆盖到画面」：热力叠层叠加到图像视口，与其他覆盖互斥；面板下方预览与画布相反的状态",
  "S 直方图与低/高饱和占比在「饱和度检查」tab",
];

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function SaturationPanel() {
  const image = useLabStore((s) => s.image);
  const pointer = useLabStore((s) => s.pointer);
  const satMode = useLabStore((s) => s.satMode);
  const setSatMode = useLabStore((s) => s.setSatMode);
  const overlay = useLabStore((s) => s.overlay);
  const setOverlay = useLabStore((s) => s.setOverlay);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [redrawKey, setRedrawKey] = useState(0);

  // 范围联动
  const [showLow, setShowLow] = useState(false);
  const [showHigh, setShowHigh] = useState(false);

  // 光标竖线
  const hoverS: number | null = pointer ? Math.round(pointer.s) : null;

  const satHist = useMemo(() => computeSaturationHistogram(), [image?.name, image?.width, image?.height, image?.url]); // eslint-disable-line

  const lowPct = satHist ? (satHist.hist.slice(0, 21).reduce((a, b) => a + b, 0) / satHist.total * 100).toFixed(1) : "—";
  const highPct = satHist ? (satHist.hist.slice(80, 101).reduce((a, b) => a + b, 0) / satHist.total * 100).toFixed(1) : "—";

  const overlayId: OverlayTool = satMode === "check" ? "sat-check" : "sat-heat";
  const on = overlay === overlayId;
  const infoLines = satMode === "check" ? SAT_CHECK_INFO : SAT_HEAT_INFO;

  // 反向预览
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) { setPreviewUrl(null); return; }
    let cancelled = false;
    if (on) {
      setPreviewUrl(image.url);
    } else {
      void getOverlayImageUrl(overlayId).then((url) => {
        if (cancelled || !url) return;
        setPreviewUrl(url);
      });
    }
    return () => { cancelled = true; };
  }, [on, overlayId, image, image?.url]);

  /* ---- 绘制：S 直方图 + 范围罩 + 均值线（仅检查 tab） ---- */
  useEffect(() => {
    if (satMode !== "check") return;
    const canvas = canvasRef.current;
    if (!canvas || !satHist) return;
    const dc = setupDrawCtx(canvas);
    if (!dc) return;

    const { ctx, w, plotH, plotY, text3, axisFont } = dc;
    const baseY = plotY + plotH;
    const accent = readToken("--accent") || "#6366f1";
    const accentWeak = readToken("--accent-weak") || "rgb(0 96 223 / 10%)";
    const text1 = readToken("--text-1") || "#1a1a1e";
    const meanX = (satHist.mean / 100) * w;

    // 范围罩（曲线之下 fill，先画）
    if (showLow || showHigh) {
      ctx.fillStyle = accentWeak;
      if (showLow) ctx.fillRect(0, plotY, (20 / 100) * w, plotH);
      if (showHigh) ctx.fillRect((80 / 100) * w, plotY, w - (80 / 100) * w, plotH);

      // 范围边界竖线
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      if (showLow) {
        const lx = Math.round((20 / 100) * w) + 0.5;
        ctx.beginPath(); ctx.moveTo(lx, plotY); ctx.lineTo(lx, plotY + plotH); ctx.stroke();
      }
      if (showHigh) {
        const hx = Math.round((80 / 100) * w) + 0.5;
        ctx.beginPath(); ctx.moveTo(hx, plotY); ctx.lineTo(hx, plotY + plotH); ctx.stroke();
      }
    }

    // S 曲线填充
    const bins = new Float64Array(101);
    for (let i = 0; i < 101; i++) bins[i] = satHist.hist[i];
    const smooth = smoothBins(bins);
    const maxVal = Math.max(1, ...smooth);

    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.7;
    traceCurve(ctx, smooth, w, baseY, plotH, maxVal, true);
    ctx.globalAlpha = 1;

    // 均值线
    ctx.strokeStyle = text1;
    ctx.lineWidth = 1;
    const mx = Math.round(meanX) + 0.5;
    ctx.beginPath(); ctx.moveTo(mx, plotY); ctx.lineTo(mx, plotY + plotH); ctx.stroke();
    // 均值标签
    ctx.fillStyle = text3;
    ctx.font = axisFont;
    if (satHist.mean < 10) ctx.textAlign = "left";
    else if (satHist.mean > 90) ctx.textAlign = "right";
    else ctx.textAlign = "center";
    ctx.fillText("均值", meanX, plotY + 11);

    drawXAxis(dc, [0, 50, 100], "饱和度 S（HSL）");
    drawYTitle(dc, "像素数");
  }, [satHist, redrawKey, showLow, showHigh, satMode]);

  const forceRedraw = useCallback(() => setRedrawKey((k) => k + 1), []);

  useEffect(() => {
    const observer = new MutationObserver(forceRedraw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [forceRedraw]);

  useEffect(() => {
    const el = document.getElementById("lab-output-wrapper");
    if (!el) return;
    const ro = new ResizeObserver(forceRedraw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [forceRedraw]);

  /* ---- 渲染 ---- */

  if (!image) {
    return (
      <>
        <header className="lab-panel__header">
          <h1 className="lab-panel__name">饱和度</h1>
          <PanelInfoButton lines={infoLines} />
        </header>
        <div className="lab-hist__tabs">
          <button type="button" className={`lab-hist__seg${satMode === "check" ? " is-active" : ""}`} onClick={() => setSatMode("check")}>饱和度检查</button>
          <button type="button" className={`lab-hist__seg${satMode === "heat" ? " is-active" : ""}`} onClick={() => setSatMode("heat")}>饱和热力</button>
        </div>
        <div className="lab-panel__card">打开图像后，这里显示该工具的分析结果</div>
      </>
    );
  }

  return (
    <>
      <header className="lab-panel__header">
        <h1 className="lab-panel__name">饱和度</h1>
        <PanelInfoButton lines={infoLines} />
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`lab-switch${on ? " is-on" : ""}`}
          title="覆盖到画面"
          onClick={() => setOverlay(on ? null : overlayId)}
        />
      </header>

      <div className="lab-hist__tabs">
        <button type="button" className={`lab-hist__seg${satMode === "check" ? " is-active" : ""}`} onClick={() => setSatMode("check")}>饱和度检查</button>
        <button type="button" className={`lab-hist__seg${satMode === "heat" ? " is-active" : ""}`} onClick={() => setSatMode("heat")}>饱和热力</button>
      </div>

      <div className="lab-panel__card">
        {/* 反向预览（两 tab 共有，图表之上） */}
        <div className="lab-sat__preview">
          <div className="lab-sat__preview-frame" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
            {previewUrl && <img className="lab-sat__preview-img" src={previewUrl} alt="" draggable={false} />}
          </div>
        </div>

        {satMode === "check" && (
          <>
            <div className="lab-hist__canvas-wrap">
              <canvas ref={canvasRef} className="lab-hist__canvas" />
              {hoverS !== null && (
                <div
                  className="lab-hist__cursor-line"
                  style={{ left: `${hoverS}%` }}
                  aria-hidden="true"
                />
              )}
            </div>

            <div className="lab-hist__readout">
              <span className="lab-hist__chip">
                均值 S <span className="lab-hist__value">{satHist ? satHist.mean.toFixed(1) : "—"}</span>
              </span>
              <button
                type="button"
                role="switch"
                aria-pressed={showLow}
                className={`lab-hist__chip${showLow ? " is-active" : ""}`}
                onClick={() => setShowLow((v) => !v)}
              >
                低饱和 <span className="lab-hist__value">{lowPct}%</span>
              </button>
              <button
                type="button"
                role="switch"
                aria-pressed={showHigh}
                className={`lab-hist__chip${showHigh ? " is-active" : ""}`}
                onClick={() => setShowHigh((v) => !v)}
              >
                高饱和 <span className="lab-hist__value">{highPct}%</span>
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
