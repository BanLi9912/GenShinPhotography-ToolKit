/**
 * 共享绘制工具（M4.3.2）：轴区参数 / token 读取 / 平滑 / 曲线 / 轴标注。
 * 从 HistogramPanel 抽出，供 HistogramPanel 与 SaturationPanel 共用。
 * 绘制算法原样搬运，不顺手改实现。
 */

/** 画布通用轴区常量（与 M4.2.1 修订口径一致） */
export const AXIS_BOTTOM = 36;
export const AXIS_TOP = 16;

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  plotH: number;
  plotY: number;
  lineColor: string;
  text3: string;
  axisFont: string;
}

/** token 读取 helper（仿 useCssToken 写法） */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function setupDrawCtx(canvas: HTMLCanvasElement): DrawContext | null {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w === 0 || h === 0) return null;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const lineColor = readToken("--line") || "#e1e1e4";
  const text3 = readToken("--text-2") || "#56565e"; // 图表标注用次文字色（深色模式 #a3a3a3，对比度 ≥4.5:1）
  const fontSize = readToken("--text-xs") || "11px";
  const fontMono = readToken("--font-mono") || "monospace";
  const axisFont = `${fontSize} ${fontMono}`;

  const plotH = h - AXIS_BOTTOM - AXIS_TOP;
  const plotY = AXIS_TOP;

  return { ctx, w, h, plotH, plotY, lineColor, text3, axisFont };
}

/* ---- Apple 风格平滑与曲线 ---- */

/** 5-bin 移动平均（边缘取可用窗口），输入输出等长 */
export function smoothBins(bins: Float64Array): Float64Array {
  const n = bins.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    const lo = Math.max(0, i - 2);
    const hi = Math.min(n - 1, i + 2);
    for (let j = lo; j <= hi; j++) { sum += bins[j]; count++; }
    out[i] = sum / count;
  }
  return out;
}

/**
 * midpoint quadratic 平滑路径：过各点中点的二次贝塞尔。
 * fill=true 时闭合到基线填充，否则仅描边。
 * @param baseY 基线 Y（= plotY + plotH）
 */
export function traceCurve(
  ctx: CanvasRenderingContext2D,
  vals: Float64Array,
  w: number,
  baseY: number,
  plotH: number,
  max: number,
  fill: boolean,
): void {
  const n = vals.length;
  const binW = w / n;
  ctx.beginPath();

  let px = 0.5 * binW;
  let py = baseY - (vals[0] / max) * (plotH - 4);
  ctx.moveTo(px, py);

  for (let i = 1; i < n; i++) {
    const cx = (i + 0.5) * binW;
    const cy = baseY - (vals[i] / max) * (plotH - 4);
    const mx = (px + cx) / 2;
    const my = (py + cy) / 2;
    ctx.quadraticCurveTo(px, py, mx, my);
    px = cx;
    py = cy;
  }
  ctx.lineTo(px, py);

  if (fill) {
    ctx.lineTo(w, baseY);
    ctx.lineTo(0, baseY);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.stroke();
  }
}

/* ---- 轴标注 ---- */

/** 横轴：基线 + 刻度 + 轴题 */
export function drawXAxis(dc: DrawContext, ticks: number[], title: string) {
  const { ctx, w, plotH, plotY, lineColor, text3, axisFont } = dc;
  const bx = plotY + plotH;

  // 基线
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(bx) + 0.5);
  ctx.lineTo(w, Math.round(bx) + 0.5);
  ctx.stroke();

  // 刻度
  ctx.fillStyle = text3;
  ctx.font = axisFont;
  const tMin = ticks[0];
  const tMax = ticks[ticks.length - 1];
  for (const t of ticks) {
    const tx = ((t - tMin) / (tMax - tMin)) * w;
    if (t === tMin) ctx.textAlign = "left";
    else if (t === tMax) ctx.textAlign = "right";
    else ctx.textAlign = "center";
    ctx.fillText(`${t}`, t === tMin ? 2 : t === tMax ? w - 2 : tx, bx + 13);
  }

  // 轴题
  ctx.textAlign = "center";
  ctx.fillText(title, w / 2, bx + 28);
}

/** 纵轴轴题 */
export function drawYTitle(dc: DrawContext, title: string) {
  const { ctx, plotY, text3, axisFont } = dc;
  ctx.fillStyle = text3;
  ctx.font = axisFont;
  ctx.textAlign = "left";
  ctx.fillText(title, 4, plotY - 4);
}
