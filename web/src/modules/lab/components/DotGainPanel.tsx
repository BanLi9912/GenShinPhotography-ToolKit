/**
 * Dot Gain 20% 面板（任务 M4.4）：覆盖开关 + 对照直方图（原图灰底 vs 校样 accent 线）。
 * 去壳返回，外壳与翻页由 LabPanel 统一负责。
 * Canvas 2D 绘制，Apple 风格平滑填充曲线 + 平滑描边线，色值全部经 CSS token 读取。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "../store";
import { computeDotGainHistogram } from "../dotgain";
import { luma } from "../../../core/imaging/color";
import { getOverlayImageUrl } from "../imageSource";
import { PanelInfoButton } from "./PanelInfo";
import {
  setupDrawCtx,
  smoothBins,
  traceCurve,
  drawXAxis,
  drawYTitle,
} from "./chartUtils";

const DOTGAIN_INFO_LINES = [
  "灰度化（Rec.601 luma）+ 网点增大 20% 特性曲线：模拟印刷网点扩大，中间调压暗（50% 网点 → 约 70%）",
  "「覆盖到画面」：校样叠加到图像视口，120ms 淡入淡出；同一时刻至多一个覆盖",
  "对照直方图：灰底 = 原图明度分布，accent 线 = 校样灰度分布",
];

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function DotGainPanel() {
  const image = useLabStore((s) => s.image);
  const overlay = useLabStore((s) => s.overlay);
  const setOverlay = useLabStore((s) => s.setOverlay);
  const pointer = useLabStore((s) => s.pointer);

  // 光标竖线：指针在图上时取 Rec.601 luma（0–255），图外/null 时不画
  const hoverLuma: number | null = pointer
    ? Math.round(luma(pointer.r, pointer.g, pointer.b))
    : null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [redrawKey, setRedrawKey] = useState(0);

  const dgHist = useMemo(() => computeDotGainHistogram(), [image?.name, image?.width, image?.height, image?.url]); // eslint-disable-line

  const on = overlay === "dotgain";

  // 反向预览
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) { setPreviewUrl(null); return; }
    let cancelled = false;
    if (on) {
      setPreviewUrl(image.url);
    } else {
      void getOverlayImageUrl("dotgain").then((url) => {
        if (cancelled || !url) return;
        setPreviewUrl(url);
      });
    }
    return () => { cancelled = true; };
  }, [on, image, image?.url]);

  /* ---- 绘制：对照直方图（原图灰底填充 + 校样 accent 线） ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !dgHist) return;
    const dc = setupDrawCtx(canvas);
    if (!dc) return;

    const { ctx, w, plotH, plotY, text3 } = dc;
    const baseY = plotY + plotH;
    const accent = readToken("--accent") || "#6366f1";

    // 原图：平滑填充（灰底，同直方图明度模式）
    const orig = new Float64Array(256);
    const proof = new Float64Array(256);
    for (let i = 0; i < 256; i++) { orig[i] = dgHist.orig[i]; proof[i] = dgHist.proof[i]; }
    const so = smoothBins(orig);
    const sp = smoothBins(proof);
    const jointMax = Math.max(1, ...so, ...sp);

    // 灰底填充（text3 + alpha 0.7）
    ctx.fillStyle = text3;
    ctx.globalAlpha = 0.7;
    traceCurve(ctx, so, w, baseY, plotH, jointMax, true);
    ctx.globalAlpha = 1;

    // 校样 accent 描边线（1.5px）
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    traceCurve(ctx, sp, w, baseY, plotH, jointMax, false);

    drawXAxis(dc, [0, 64, 128, 192, 255], "灰度值");
    drawYTitle(dc, "像素数");
  }, [dgHist, redrawKey]);

  const forceRedraw = useCallback(() => setRedrawKey((k) => k + 1), []);

  // 主题切换 → 重绘
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

  // 无图状态
  if (!image) {
    return (
      <>
        <header className="lab-panel__header">
          <h1 className="lab-panel__name">Dot Gain 20%</h1>
          <PanelInfoButton lines={DOTGAIN_INFO_LINES} />
        </header>
        <div className="lab-panel__card">打开图像后，这里显示该工具的分析结果</div>
      </>
    );
  }

  return (
    <>
      <header className="lab-panel__header">
        <h1 className="lab-panel__name">Dot Gain 20%</h1>
        <PanelInfoButton lines={DOTGAIN_INFO_LINES} />
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`lab-switch${on ? " is-on" : ""}`}
          title="覆盖到画面"
          onClick={() => setOverlay(on ? null : "dotgain")}
        />
      </header>

      <div className="lab-panel__card">
        <div className="lab-sat__preview">
          <div className="lab-sat__preview-frame" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
            {previewUrl && <img className="lab-sat__preview-img" src={previewUrl} alt="" draggable={false} />}
          </div>
        </div>

        <div className="lab-hist__canvas-wrap">
          <canvas ref={canvasRef} className="lab-hist__canvas" />
          {hoverLuma !== null && (
            <div
              className="lab-hist__cursor-line"
              style={{ left: `${(hoverLuma / 255) * 100}%` }}
              aria-hidden="true"
            />
          )}
        </div>

        <div className="lab-hist__readout">
          <span className="lab-hist__chip">
            <span className="lab-hist__dot" style={{ background: "var(--text-3)", opacity: 0.6 }} />
            原图
          </span>
          <span className="lab-hist__chip">
            <span className="lab-hist__dot" style={{ background: "var(--accent)", opacity: 0.8 }} />
            校样
          </span>
        </div>
      </div>
    </>
  );
}
