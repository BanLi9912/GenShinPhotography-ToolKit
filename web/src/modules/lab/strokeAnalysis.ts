/**
 * 划线取色路径采样（开发文档-M4 §4.2/§5.2）：弧长计算 + 均匀采样 + 宽度均值抗噪。
 * 纯函数，无 React 依赖；色彩口径统一走 colorUtils；缓存由调用方负责。
 * M4.9 追加：事件检测（L 最大跃迁 / H 色环最短距跳变 / S 峰值）、明度峰谷、事件描述句。
 */
import { rgbToHsl } from "../../core/imaging/color";
import { getFullImageData } from "./imageSource";
import type { StrokeSample } from "./store";

/** 折线弧长（图像 px） */
export function pathLength(points: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

/**
 * 沿路径按弧长均匀采样 + 宽度均值抗噪。
 * 步长 step（图像 px）、采样宽度 width（px，奇偶均可，方形窗口居中）；
 * 返回 null = 无图像。终点强制补 t=1（浮点步进可能漏末尾）。
 */
export function sampleStroke(
  points: { x: number; y: number }[],
  step: number,
  width: number,
): { samples: StrokeSample[]; totalLen: number } | null {
  const imgData = getFullImageData();
  if (!imgData || points.length < 2) return null;

  const totalLen = pathLength(points);
  if (totalLen < step) {
    // 路径太短：至少采一个点
    const p = points[0];
    const s = makeSample(imgData, Math.round(p.x), Math.round(p.y), 0, width);
    return { samples: s ? [s] : [], totalLen };
  }

  const samples: StrokeSample[] = [];
  let dist = 0;
  let segIdx = 0;

  while (dist <= totalLen) {
    // 在折线上定位 dist
    let walked = 0;
    let sx = points[0].x, sy = points[0].y;
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1].x - points[i].x;
      const dy = points[i + 1].y - points[i].y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (walked + segLen >= dist) {
        const t = segLen > 0 ? (dist - walked) / segLen : 0;
        sx = points[i].x + dx * t;
        sy = points[i].y + dy * t;
        segIdx = i;
        break;
      }
      walked += segLen;
    }

    const s = makeSample(imgData, Math.round(sx), Math.round(sy), dist / totalLen, width);
    if (s) samples.push(s);
    dist += step;
    if (segIdx === 0 && dist > totalLen) break;
  }

  // 终点强制补 t=1
  const last = points[points.length - 1];
  const lastS = makeSample(imgData, Math.round(last.x), Math.round(last.y), 1, width);
  if (lastS && (samples.length === 0 || samples[samples.length - 1].t < 0.99)) {
    samples.push(lastS);
  }

  return { samples, totalLen };
}

function makeSample(
  imgData: ImageData,
  cx: number, cy: number,
  t: number,
  width: number,
): StrokeSample | null {
  const { data } = imgData;
  const w = imgData.width;
  const h = imgData.height;
  const half = Math.floor(width / 2);
  let rSum = 0, gSum = 0, bSum = 0, n = 0;
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const off = (y * w + x) * 4;
      rSum += data[off];
      gSum += data[off + 1];
      bSum += data[off + 2];
      n++;
    }
  }
  if (n === 0) return null;
  const r = Math.round(rSum / n);
  const g = Math.round(gSum / n);
  const b = Math.round(bSum / n);
  const { h: hue, s, l } = rgbToHsl(r, g, b);
  return { x: cx, y: cy, r, g, b, h: hue, s, l, t };
}

/**
 * 代表性取样点抽取（任务 M4.8.1）：起点、终点 + 变化最剧烈的前 maxChangePoints 个位置。
 * 变化分 = 亮度跃迁 + 色度跳变（dL/100 + (dH/180 + dS/100)/2，H 按色环最短距）；
 * 仅收 score ≥ 0.08 的候选，且与已选点 t 间距 ≥ 0.06、索引间距 ≥ 3。
 * 返回 samples 下标数组（含 0 与 n-1，按 t 升序）；samples.length < 2 返回 []。
 */
export function selectStrokeKeyPoints(samples: StrokeSample[], maxChangePoints = 3): number[] {
  const n = samples.length;
  if (n < 2) return [];

  // 计算每个中间点的变化分
  interface Candidate { i: number; score: number; }
  const cands: Candidate[] = [];
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dL = Math.abs(b.l - a.l) / 100;
    let dH = Math.abs(b.h - a.h);
    if (dH > 180) dH = 360 - dH; // 色环最短距
    dH /= 180;
    const dS = Math.abs(b.s - a.s) / 100;
    const score = dL + (dH + dS) / 2;
    if (score >= 0.08) cands.push({ i, score });
  }

  // 按 score 降序贪心入选
  cands.sort((a, b) => b.score - a.score);
  const selected: number[] = [0]; // 起点
  for (const c of cands) {
    if (selected.length - 1 >= maxChangePoints) break; // 不含起终点，最多 maxChangePoints 个变化点
    // 间距检查
    let ok = true;
    for (const si of selected) {
      if (Math.abs(c.i - si) < 3) { ok = false; break; }
      // t 间距 ≥ 0.06（用 samples t 值）
      if (Math.abs(samples[c.i].t - samples[si].t) < 0.06) { ok = false; break; }
    }
    // 与终点间距
    if (Math.abs(c.i - (n - 1)) < 3) ok = false;
    if (Math.abs(samples[c.i].t - samples[n - 1].t) < 0.06) ok = false;

    if (ok) selected.push(c.i);
  }
  selected.push(n - 1); // 终点
  selected.sort((a, b) => a - b);
  return selected;
}

/* ---- 事件检测 + 明度峰谷（任务 M4.9，事件口径移植演示 :828-836） ---- */

/** 色环最短距（0–180）；H 跳变与判定共用 */
function hueDiff(a: number, b: number): number {
  const d = Math.abs(a - b);
  return d > 180 ? 360 - d : d;
}

/** 划线事件（开发文档-M4 §4.2 解读辅助）：L 最大跃迁 / H 最大跳变（色环最短距）/ S 峰值 */
export interface StrokeEvents {
  /** L 跃迁：终点侧下标、Δl（0–100 正数）、方向（true=骤降） */
  li: number; ld: number; lDown: boolean;
  /** H 跳变：终点侧下标、跳变度数（0–180） */
  hi: number; hd: number;
  /** S 峰值：下标、峰值（0–100） */
  si: number; sv: number;
}

/** 事件检测；samples.length < 2 返回 null。移植演示 :828-836 */
export function computeStrokeEvents(samples: StrokeSample[]): StrokeEvents | null {
  const n = samples.length;
  if (n < 2) return null;

  let li = 1, ld = -1, hi = 1, hd = -1, si = 0, sv = -1;
  for (let i = 1; i < n; i++) {
    const dl = Math.abs(samples[i].l - samples[i - 1].l);
    if (dl > ld) { ld = dl; li = i; }
    const dh = hueDiff(samples[i].h, samples[i - 1].h);
    if (dh > hd) { hd = dh; hi = i; }
  }
  for (let i = 0; i < n; i++) {
    if (samples[i].s > sv) { sv = samples[i].s; si = i; }
  }
  return { li, ld, lDown: samples[li].l < samples[li - 1].l, hi, hd, si, sv };
}

/**
 * 峰谷（明度剖面高亮用）：raw l 序列上检测，窗宽 k=clamp(round(n/60),2,8)，
 * 峰=窗内最大且突出度≥5、谷=窗内最小且突出度≥5（突出度=与窗内对侧极值之差），
 * 按突出度降序各取前 3，索引间距≥k。首尾不参与（起/终已有专属标注）。
 * 返回下标数组（按 t 升序）。
 */
export function findLumaExtrema(
  samples: StrokeSample[],
): { peaks: number[]; valleys: number[] } {
  const empty = { peaks: [], valleys: [] };
  const n = samples.length;
  if (n < 3) return empty;

  const k = Math.max(2, Math.min(8, Math.round(n / 60)));
  interface Cand { i: number; prom: number; }
  const peakCands: Cand[] = [];
  const valleyCands: Cand[] = [];

  for (let i = 1; i < n - 1; i++) {
    const lo = Math.max(0, i - k);
    const hi = Math.min(n - 1, i + k);
    let mx = -Infinity;
    let mn = Infinity;
    for (let j = lo; j <= hi; j++) {
      const v = samples[j].l;
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    const v = samples[i].l;
    if (v === mx && v - mn >= 5) peakCands.push({ i, prom: v - mn });
    if (v === mn && mx - v >= 5) valleyCands.push({ i, prom: mx - v });
  }

  const pick = (cands: Cand[]): number[] => {
    cands.sort((a, b) => b.prom - a.prom);
    const picked: number[] = [];
    for (const c of cands) {
      if (picked.length >= 3) break;
      if (picked.every((pi) => Math.abs(pi - c.i) >= k)) picked.push(c.i);
    }
    picked.sort((a, b) => a - b);
    return picked;
  };

  return { peaks: pick(peakCands), valleys: pick(valleyCands) };
}

const HUE_NAMES = ["红", "橙", "黄", "黄绿", "绿", "青绿", "青", "蓝青", "蓝", "紫蓝", "紫", "品红"];

/** 色相名（12 区，每区 30°，以 0°=红起）：红/橙/黄/黄绿/绿/青绿/青/蓝青/蓝/紫蓝/紫/品红 */
export function hueName(h: number): string {
  const zone = Math.floor((((h % 360) + 360) % 360) / 30) % 12;
  return HUE_NAMES[zone];
}

/** 单条事件描述（kind/t 与 note/short；文案只在 describeStrokeEvents 一处定义，禁止两处各写） */
export type StrokeEventNote = {
  kind: "luma-jump" | "hue-jump" | "sat-peak";
  t: number;
  /** 完整句（导出 PNG / ⓘ 说明窗用） */
  note: string;
  /** 抽屉事件行短句（M4.9.1 修订：长说明移入 ⓘ 说明窗） */
  short: string;
};

/**
 * 三句事件描述（完整句 note + 短句 short，同一来源，禁止两处各写文案）：
 *  L：`明度{骤降|骤升} Δ{round(ld)}（t≈{t}）—— 全场最大明暗转折`
 *  H：`色相跳变 {round(hd)}°（t≈{t}）：{hueName(h0)} → {hueName(h1)} —— 色彩转向最明显处`
 *  S：`饱和度峰值 {round(sv)}%（t≈{t}）—— 全场最艳`
 */
export function describeStrokeEvents(
  samples: StrokeSample[],
  events: StrokeEvents,
): StrokeEventNote[] {
  const { li, ld, lDown, hi, hd, si, sv } = events;
  return [
    {
      kind: "luma-jump",
      t: samples[li].t,
      note: `明度${lDown ? "骤降" : "骤升"} Δ${Math.round(ld)}（t≈${samples[li].t.toFixed(2)}）—— 全场最大明暗转折`,
      short: `明度${lDown ? "骤降" : "骤升"} Δ${Math.round(ld)}（t≈${samples[li].t.toFixed(2)}）`,
    },
    {
      kind: "hue-jump",
      t: samples[hi].t,
      note: `色相跳变 ${Math.round(hd)}°（t≈${samples[hi].t.toFixed(2)}）：${hueName(samples[hi - 1].h)} → ${hueName(samples[hi].h)} —— 色彩转向最明显处`,
      short: `色相跳变 ${Math.round(hd)}°（t≈${samples[hi].t.toFixed(2)}）`,
    },
    {
      kind: "sat-peak",
      t: samples[si].t,
      note: `饱和度峰值 ${Math.round(sv)}%（t≈${samples[si].t.toFixed(2)}）—— 全场最艳`,
      short: `饱和度峰值 ${Math.round(sv)}%（t≈${samples[si].t.toFixed(2)}）`,
    },
  ];
}
