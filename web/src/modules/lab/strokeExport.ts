/**
 * 划线说明图导出（任务 M4.9）：`ystk/stroke-analysis` 数据 + 离屏 canvas 合成 PNG。
 * 导出管线先建数据再渲染（buildStrokeAnalysisData → exportStrokePng）。
 * 导出图是内容产物：色值尽量经 CSS token（当前主题），读不到时回退内容色（注释标明）。
 */
import { computeStrokeEvents, describeStrokeEvents } from "./strokeAnalysis";
import type { StrokeEventNote } from "./strokeAnalysis";
import { getSourceCanvas } from "./imageSource";
import { smoothBins, traceCurve } from "./components/chartUtils";
import { useLabStore } from "./store";
import type { StrokeLine } from "./store";

/** v0.2 §4.4 `ystk/stroke-analysis` 数据（series 归一化：h/360、s/100、l/100） */
export interface StrokeAnalysisData {
  schemaVersion: 1;
  type: "ystk/stroke-analysis";
  stroke: {
    points: [number, number][];
    sampleWidth: number;
    samples: number;
  };
  space: "hsl";
  series: { h: number[]; s: number[]; l: number[] };
  /** 按 v0.2 §4.4 schema：仅 kind/t/note（抽屉短句 short 不进入导出数据） */
  events: Omit<StrokeEventNote, "short">[];
}

/** v0.2 §4.4 数据格式（导出管线先建数据再渲染，series 归一化：h/360、s/100、l/100） */
export function buildStrokeAnalysisData(line: StrokeLine): StrokeAnalysisData {
  const ev = computeStrokeEvents(line.samples);
  return {
    schemaVersion: 1,
    type: "ystk/stroke-analysis",
    stroke: {
      points: line.points.map((p): [number, number] => [p.x, p.y]),
      sampleWidth: useLabStore.getState().strokeWidth,
      samples: line.samples.length,
    },
    space: "hsl",
    series: {
      h: line.samples.map((s) => s.h / 360),
      s: line.samples.map((s) => s.s / 100),
      l: line.samples.map((s) => s.l / 100),
    },
    events: ev
      ? describeStrokeEvents(line.samples, ev).map(({ kind, t, note }) => ({ kind, t, note }))
      : [],
  };
}

/** 合成说明图 PNG 并触发下载；无图/样本不足返回 false */
export function exportStrokePng(line: StrokeLine, imageName: string): boolean {
  const src = getSourceCanvas();
  if (!src || line.samples.length < 2) return false;

  const data = buildStrokeAnalysisData(line);
  const n = line.samples.length;

  // token（双主题下取当前主题；读不到回退内容色）
  const readToken = (name: string, fb: string): string =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  const panelBg = readToken("--bg-panel", "#1e1e1e");
  const lineClr = readToken("--line", "rgba(255,255,255,0.14)");
  const text2 = readToken("--text-2", "#a3a3a3");
  const accent = readToken("--accent", "#6366f1");
  const dotStroke = readToken("--bg-panel", "transparent");

  // 图像区：等比缩放到宽 W = min(源宽, 1600)
  const W = Math.min(src.width, 1600);
  const scale = W / src.width;
  const imgH = Math.round(src.height * scale);

  // 信息条：标题 / 色带 48px / 曲线 260px / 事件句一行，内边距 16px
  const pad = 16;
  const titleH = 20;
  const stripH = 48;
  const curveH = 260;
  const eventsH = 18;
  const gap = 8;
  const infoH = pad + titleH + gap + stripH + gap + curveH + gap + eventsH + pad;
  const H = imgH + infoH;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  ctx.fillStyle = panelBg;
  ctx.fillRect(0, imgH, W, infoH);

  // 图像 + 路径折线 + 两端点圆点
  ctx.drawImage(src, 0, 0, W, imgH);
  const lw = Math.max(2, W / 600);
  ctx.strokeStyle = line.color;
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  line.points.forEach((p, i) => {
    const x = p.x * scale;
    const y = p.y * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const dotR = Math.max(3, lw * 1.2);
  ctx.fillStyle = line.color;
  for (const p of [line.points[0], line.points[line.points.length - 1]]) {
    ctx.beginPath();
    ctx.arc(p.x * scale, p.y * scale, dotR, 0, Math.PI * 2);
    ctx.fill();
  }

  const font = "ui-sans-serif, system-ui, sans-serif";

  // 标题行
  ctx.fillStyle = text2;
  ctx.font = `12px ${font}`;
  ctx.textBaseline = "top";
  ctx.fillText(`${imageName} · 线${line.id} · ${Math.round(line.totalLen)}px`, pad, pad);

  // 色带（逐列 rgb，同抽屉 drawStrip）
  let y = pad + titleH + gap;
  const stripW = W - pad * 2;
  for (let x = 0; x < stripW; x++) {
    const idx = Math.min(n - 1, Math.floor((x / stripW) * n));
    const s = line.samples[idx];
    ctx.fillStyle = `rgb(${s.r},${s.g},${s.b})`;
    ctx.fillRect(pad + x, y, 1, stripH);
  }

  // 曲线区（HSL 三通道全开，画法移植 StrokeDrawer）
  y += stripH + gap;
  const plotL = pad + 8;
  const plotR = W - pad - 8;
  const plotT = y + 10;
  const plotB = y + curveH - 10;
  const plotW = plotR - plotL;
  const plotH = plotB - plotT;

  // 网格 0/0.5/1
  ctx.strokeStyle = lineClr;
  ctx.lineWidth = 0.5;
  for (const frac of [0, 0.5, 1]) {
    const gy = plotT + plotH * (1 - frac);
    ctx.beginPath();
    ctx.moveTo(plotL, Math.round(gy) + 0.5);
    ctx.lineTo(plotR, Math.round(gy) + 0.5);
    ctx.stroke();
  }

  // H 分段彩虹（内容色）
  ctx.lineWidth = 1.2;
  for (let i = 0; i < n - 1; i++) {
    const x0 = plotL + (i / (n - 1)) * plotW;
    const x1 = plotL + ((i + 1) / (n - 1)) * plotW;
    const y0 = plotT + plotH * (1 - data.series.h[i]);
    const y1 = plotT + plotH * (1 - data.series.h[i + 1]);
    ctx.strokeStyle = `hsl(${Math.round(data.series.h[i] * 360)},80%,48%)`; // 内容色
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  // L / S 平滑曲线（smoothBins + traceCurve，同抽屉）
  const smL = smoothBins(new Float64Array(data.series.l));
  const smS = smoothBins(new Float64Array(data.series.s));
  const drawSmooth = (smoothed: Float64Array, color: string) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, plotT, plotW, plotH);
    ctx.clip();
    ctx.translate(plotL, plotT);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    traceCurve(ctx, smoothed, plotW, plotH, plotH, 1, false);
    ctx.restore();
  };
  drawSmooth(smL, text2);
  drawSmooth(smS, accent);

  // 事件点（同 StrokeDrawer 4.2.2：r=3.5 实心 + 1.5px --bg-panel 描边）
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotL, plotT, plotW, plotH);
  ctx.clip();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = dotStroke;
  for (const e of data.events) {
    const idx = Math.round(e.t * (n - 1));
    // 与曲线同坐标口径：L/S 用平滑值 + traceCurve 公式，H 为未平滑直线用线性坐标
    const x = e.kind === "hue-jump"
      ? plotL + (idx / (n - 1)) * plotW
      : plotL + ((idx + 0.5) / n) * plotW;
    const dy = e.kind === "hue-jump"
      ? plotT + plotH * (1 - data.series.h[idx])
      : plotT + plotH - (e.kind === "luma-jump" ? smL[idx] : smS[idx]) * (plotH - 4);
    ctx.fillStyle =
      e.kind === "luma-jump" ? text2 :
      e.kind === "sat-peak" ? accent :
      `hsl(${Math.round(data.series.h[idx] * 360)},80%,48%)`; // 内容色
    ctx.beginPath();
    ctx.arc(x, dy, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // 事件句一行（三句全角空格分隔）
  y += curveH + gap;
  ctx.fillStyle = text2;
  ctx.font = `11px ${font}`;
  ctx.fillText(data.events.map((e) => e.note).join("　"), pad, y);

  // 触发下载
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${imageName.replace(/\.[^.]+$/, "")}-线${line.id}-分析.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, "image/png");

  return true;
}
