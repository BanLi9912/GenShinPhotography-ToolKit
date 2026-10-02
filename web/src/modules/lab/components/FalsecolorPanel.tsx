/**
 * 假彩色面板（任务 M4.6）：反向预览 + 色带着色明度直方图 + 色带图例 +
 * 暗部/削波占比（点击 chip 在直方图上显示对应范围罩，联动模式同 SaturationPanel）。
 * 去壳返回，外壳与翻页由 LabPanel 统一负责；无子模式（无 tab/flyout）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "../store";
import {
  buildFalseColorLut,
  computeFalseColorHistogram,
  falseColorClipPct,
  falseColorShadowPct,
  FALSE_COLOR_STOPS,
} from "../falsecolor";
import { getOverlayImageUrl, getSampledImageData } from "../imageSource";
import { PanelInfoButton } from "./PanelInfo";
import { setupDrawCtx, drawXAxis, drawYTitle } from "./chartUtils";

const INFO_LINES = [
  "明度映射到影视 False Color 标准色带：暗部蓝紫 → 中调绿 → 亮部橙红，近削波品红警示",
  "「覆盖到画面」：假彩色视图叠加到图像视口，与其他覆盖互斥；面板下方预览与画布相反的状态",
  "直方图按明度分布着色（与画面同一色带）；点「暗部/削波」chip 高亮对应范围",
];

/** 色带图例渐变（CSS linear-gradient 串，由色标表生成——图例与 LUT 永远同源） */
const LEGEND_GRADIENT = `linear-gradient(90deg, ${FALSE_COLOR_STOPS.map(
  (s) => `rgb(${s.rgb.join(",")}) ${(s.at / 255 * 100).toFixed(1)}%`,
).join(", ")})`;

/** URL 取样最长边（直方图不需要全尺寸；1:1 预览仍走 imageSource 的全尺寸路径） */
const URL_SAMPLE_EDGE = 512;

/**
 * 按 URL 重新解码取样（直方图兜底取数）：等比缩到最长边 URL_SAMPLE_EDGE 后读 ImageData。
 * 失败（解码错误/无 2D 上下文）返回 null；调用方用 cancelled 标志丢弃过期结果。
 */
async function sampleImageByUrl(url: string): Promise<ImageData | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图像解码失败"));
      el.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, URL_SAMPLE_EDGE / Math.max(w, h));
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, sw, sh);
    return ctx.getImageData(0, 0, sw, sh);
  } catch {
    return null;
  }
}

function FalsecolorPanel() {
  const image = useLabStore((s) => s.image);
  const pointer = useLabStore((s) => s.pointer);
  const overlay = useLabStore((s) => s.overlay);
  const setOverlay = useLabStore((s) => s.setOverlay);

  const on = overlay === "falsecolor";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [redrawKey, setRedrawKey] = useState(0);
  const [showShadow, setShowShadow] = useState(false);
  const [showClip, setShowClip] = useState(false);
  /** 光标所在明度（0–100，hover 竖线） */
  const hoverL: number | null = pointer ? Math.round(pointer.l) : null;

  // 直方图取数：首选 App 像素源（同步、全尺寸一次到位）；若它与 store 失配
  // （Vite 就地热更后实测：store 有图、imageSource 取样为 null 或尺寸不符），
  // 退到按 URL 重新解码取样——URL 来自 store，任何模块实例下都与画面上那张图一致。
  // try/catch：像素源 canvas 尺寸为 0 时 getImageData 会抛（渲染期抛出会掀掉整个实验室页），
  // 这里一律降级为「取不到」，交给 URL 兜底。
  const pixelSample = useMemo(() => {
    try {
      return getSampledImageData();
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 口径同 SaturationPanel:54
  }, [image?.name, image?.width, image?.height, image?.url]);
  const pixelSampleStale =
    pixelSample !== null && image !== null && (pixelSample.width !== image.width || pixelSample.height !== image.height);
  const needUrlSample = image !== null && (pixelSample === null || pixelSampleStale);

  const [urlSample, setUrlSample] = useState<ImageData | null>(null);
  const [urlSampleTried, setUrlSampleTried] = useState(false);
  useEffect(() => {
    if (!needUrlSample) { setUrlSample(null); setUrlSampleTried(false); return; }
    let cancelled = false;
    void sampleImageByUrl(image.url).then((data) => {
      if (cancelled) return;
      setUrlSample(data);
      setUrlSampleTried(true);
    });
    return () => { cancelled = true; };
  }, [needUrlSample, image?.url]);

  const hist = useMemo(
    () => computeFalseColorHistogram(pixelSampleStale ? urlSample : (pixelSample ?? urlSample)),
    [pixelSample, pixelSampleStale, urlSample],
  );

  // 取数兜底自证：走了退路（或两条路都失败）时留痕，避免「空框 + —%」无声无息。
  // 等 URL 兜底跑完再判定，避免兜底进行中就误报「失败」。
  const sampleFailed = image !== null && hist === null && (!needUrlSample || urlSampleTried);
  useEffect(() => {
    if (!sampleFailed && !pixelSampleStale) return;
    console.warn(
      "[M4.6 假彩色] 直方图取数走了兜底路径 —— " +
        `image=${image.name} ${image.width}×${image.height}；` +
        `App 像素源=${pixelSample ? `${pixelSample.width}×${pixelSample.height}` : "null"}` +
        `${pixelSampleStale ? "（尺寸与 store 不符：模块实例失配）" : ""}；` +
        `URL 取样=${urlSample ? "成功" : urlSampleTried ? "失败" : "进行中"}`,
    );
  }, [sampleFailed, pixelSampleStale, pixelSample, urlSample, urlSampleTried, image]);

  // 反向预览（口径同 SaturationPanel:64-77）
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) { setPreviewUrl(null); return; }
    let cancelled = false;
    if (on) {
      setPreviewUrl(image.url);
    } else {
      void getOverlayImageUrl("falsecolor").then((url) => {
        if (cancelled || !url) return;
        setPreviewUrl(url);
      });
    }
    return () => { cancelled = true; };
  }, [on, image, image?.url]);

  /* ---- 绘制：竖条着色直方图 + 范围罩 ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hist) return;
    const dc = setupDrawCtx(canvas);
    if (!dc) return;
    const { ctx, w, plotH, plotY } = dc;
    const baseY = plotY + plotH;
    const maxVal = Math.max(1, ...hist.hist);

    // 范围罩（先画，垫底；口径同 SaturationPanel:95-98）
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent").trim() || "#6366f1";
    const accentWeak = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-weak").trim() || "rgb(0 96 223 / 10%)";
    if (showShadow || showClip) {
      ctx.fillStyle = accentWeak;
      if (showShadow) ctx.fillRect(0, plotY, (41 / 256) * w, plotH);
      if (showClip) ctx.fillRect((246 / 256) * w, plotY, (10 / 256) * w, plotH);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      if (showShadow) {
        const x = Math.round((41 / 256) * w) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, plotY); ctx.lineTo(x, plotY + plotH); ctx.stroke();
      }
      if (showClip) {
        const x = Math.round((246 / 256) * w) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, plotY); ctx.lineTo(x, plotY + plotH); ctx.stroke();
      }
    }

    // 竖条着色直方图：每个 bin 用色带对应色（与覆盖画面同一 LUT）
    const lut = buildFalseColorLut();
    const bw = w / 256;
    for (let i = 0; i < 256; i++) {
      const v = hist.hist[i];
      if (v === 0) continue;
      const bh = (v / maxVal) * plotH;
      ctx.fillStyle = `rgb(${lut[i * 3]},${lut[i * 3 + 1]},${lut[i * 3 + 2]})`;
      ctx.fillRect(i * bw, baseY - bh, Math.max(bw, 0.75), bh);
    }

    drawXAxis(dc, [0, 50, 100], "明度 Luma");
    drawYTitle(dc, "像素数");
  }, [hist, redrawKey, showShadow, showClip]);

  // 主题切换 / 面板尺寸变化重绘（口径同 SaturationPanel:141-155）
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

  if (!image) {
    return (
      <>
        <header className="lab-panel__header">
          <h1 className="lab-panel__name">假彩色</h1>
          <PanelInfoButton lines={INFO_LINES} />
        </header>
        <div className="lab-panel__card">打开图像后，这里显示该工具的分析结果</div>
      </>
    );
  }

  return (
    <>
      <header className="lab-panel__header">
        <h1 className="lab-panel__name">假彩色</h1>
        <PanelInfoButton lines={INFO_LINES} />
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`lab-switch${on ? " is-on" : ""}`}
          title="覆盖到画面"
          onClick={() => setOverlay(on ? null : "falsecolor")}
        />
      </header>

      <div className="lab-panel__card">
        {/* 反向预览（类复用 SaturationPanel） */}
        <div className="lab-sat__preview">
          <div className="lab-sat__preview-frame" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
            {previewUrl && <img className="lab-sat__preview-img" src={previewUrl} alt="" draggable={false} />}
          </div>
        </div>

        {/* 色带图例：渐变条 + 两端标注（渐变与 LUT 同源，永远一致） */}
        <div className="lab-fc__legend" aria-label="假彩色色带图例">
          <div className="lab-fc__legend-grad" style={{ background: LEGEND_GRADIENT }} />
          <div className="lab-fc__legend-ticks">
            <span>0 黑</span>
            <span>暗部</span>
            <span>中调</span>
            <span>亮部</span>
            <span>削波</span>
          </div>
        </div>

        <div className="lab-hist__canvas-wrap">
          <canvas ref={canvasRef} className="lab-hist__canvas" />
          {hoverL !== null && (
            <div className="lab-hist__cursor-line" style={{ left: `${hoverL}%` }} aria-hidden="true" />
          )}
          {/* 两条取数路径都失败：空框必须自证原因（否则只是一个「什么都没有」的框） */}
          {sampleFailed && <div className="lab-fc__empty">读不到当前图像的像素，请重新打开或换一张图</div>}
        </div>

        <div className="lab-hist__readout">
          <button
            type="button"
            role="switch"
            aria-pressed={showShadow}
            className={`lab-hist__chip${showShadow ? " is-active" : ""}`}
            onClick={() => setShowShadow((v) => !v)}
          >
            暗部{" "}
            <span className="lab-hist__value">{hist ? `${falseColorShadowPct(hist).toFixed(1)}%` : "—"}</span>
          </button>
          <button
            type="button"
            role="switch"
            aria-pressed={showClip}
            className={`lab-hist__chip${showClip ? " is-active" : ""}`}
            onClick={() => setShowClip((v) => !v)}
          >
            削波 <span className="lab-hist__value">{hist ? `${falseColorClipPct(hist).toFixed(1)}%` : "—"}</span>
          </button>
        </div>
      </div>
    </>
  );
}

export { FalsecolorPanel };
