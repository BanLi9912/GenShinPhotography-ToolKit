/**
 * 色彩和谐结构判定（任务 M4.9）：近似 / 互补 / 三角 / 分裂互补 + 与经典模板的角度偏差。
 * 纯函数模块，无 React / store 依赖；口径：开发文档-M4 §5.2 与任务卡 §4.5。
 */
export interface HarmonyColor {
  /** 色相 0–360 */
  h: number;
  /** 饱和度 0–100 */
  s: number;
  /** 占比 0–1 */
  p: number;
}

export interface HarmonyStructure {
  kind: "analogous" | "complementary" | "triadic" | "split-complementary";
  label: string;      // 近似 / 互补 / 三角 / 分裂互补
  deviation: number;  // 与经典模板偏差（度）
  detail: string;     // 例：「互补 · 偏差 8°」
}

export interface HarmonyResult {
  structures: HarmonyStructure[];
  verdict: string;
}

/** 色环最短距（0–180） */
function hueDiff(a: number, b: number): number {
  const d = Math.abs(a - b);
  return d > 180 ? 360 - d : d;
}

/** 带符号色相差（−180..180，以被比色为基准）：正 = 顺时针 */
function signedDelta(from: number, to: number): number {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

/**
 * 和谐结构判定（全部基于参与色）：
 * 1. 分裂互补（先判，检出后跳过互补）：某色两侧各有一色（δ≥150 / δ≤−150）；
 * 2. 互补：最短距 d ∈ [150,210]，取最接近 180 的一对；
 * 3. 三角：三色环上三间隔均 ∈ [90,150]，取 max|gi−120| 最小；
 * 4. 近似：任意对 d < 30，取最大跨度。
 */
export function analyzeHarmony(colors: HarmonyColor[]): HarmonyResult {
  // 预过滤：灰的色相不稳定，s > 15 才参与判定（同演示 :1040）
  const cols = colors.filter((c) => c.s > 15);
  if (cols.length < 2) {
    return { structures: [], verdict: "主色低饱和，接近无彩色结构" };
  }

  const structures: HarmonyStructure[] = [];

  // 1. 分裂互补
  let splitDev: number | null = null;
  for (const c of cols) {
    let pos: number | null = null; // 正侧最接近 +150
    let neg: number | null = null; // 负侧最接近 −150
    for (const x of cols) {
      if (x === c) continue;
      const d = signedDelta(c.h, x.h);
      if (d >= 150 && (pos === null || d < pos)) pos = d;
      if (d <= -150 && (neg === null || d > neg)) neg = d;
    }
    if (pos !== null && neg !== null) {
      const dev = (Math.abs(pos - 150) + Math.abs(neg + 150)) / 2;
      if (splitDev === null || dev < splitDev) splitDev = dev;
    }
  }
  if (splitDev !== null) {
    structures.push({
      kind: "split-complementary",
      label: "分裂互补",
      deviation: splitDev,
      detail: `分裂互补 · 偏差 ${Math.round(splitDev)}°`,
    });
  } else {
    // 2. 互补
    let compDev: number | null = null;
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        const d = hueDiff(cols[i].h, cols[j].h);
        if (d >= 150 && d <= 210) {
          const dev = Math.abs(d - 180);
          if (compDev === null || dev < compDev) compDev = dev;
        }
      }
    }
    if (compDev !== null) {
      structures.push({
        kind: "complementary",
        label: "互补",
        deviation: compDev,
        detail: `互补 · 偏差 ${Math.round(compDev)}°`,
      });
    }
  }

  // 3. 三角
  let triDev: number | null = null;
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      for (let m = j + 1; m < cols.length; m++) {
        const hs = [cols[i].h, cols[j].h, cols[m].h].sort((a, b) => a - b);
        const g1 = hs[1] - hs[0];
        const g2 = hs[2] - hs[1];
        const g3 = 360 - (hs[2] - hs[0]);
        if (g1 >= 90 && g1 <= 150 && g2 >= 90 && g2 <= 150 && g3 >= 90 && g3 <= 150) {
          const dev = Math.max(Math.abs(g1 - 120), Math.abs(g2 - 120), Math.abs(g3 - 120));
          if (triDev === null || dev < triDev) triDev = dev;
        }
      }
    }
  }
  if (triDev !== null) {
    structures.push({
      kind: "triadic",
      label: "三角",
      deviation: triDev,
      detail: `三角 · 偏差 ${Math.round(triDev)}°`,
    });
  }

  // 4. 近似
  let anaDev: number | null = null;
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const d = hueDiff(cols[i].h, cols[j].h);
      if (d < 30 && (anaDev === null || d > anaDev)) anaDev = d;
    }
  }
  if (anaDev !== null) {
    structures.push({
      kind: "analogous",
      label: "近似",
      deviation: anaDev,
      detail: `近似 · 跨度 ${Math.round(anaDev)}°`,
    });
  }

  const verdict =
    structures.length === 0
      ? "分散结构（无明显和谐关系）"
      : structures.length === 1
        ? `${structures[0].label}结构`
        : `${structures.map((s) => s.label).join(" + ")} 混合结构`;

  return { structures, verdict };
}
