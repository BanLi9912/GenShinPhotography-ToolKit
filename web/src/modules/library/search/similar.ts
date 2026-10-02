/**
 * M3.3.5 多信号加权（口径钉死，任务卡 2026-08-23-M3.3.5）：无硬阈值一票否决；
 * 只统计两侧都有数据的信号；pHash 软门控 h≤24；S≥0.25 取前 12；带贡献 top-2 理由。
 * 信号表（顺序即理由并列决胜序）：色彩 3 / 标签 3 / 轮廓 2 / 场景 2 / 主体 1 /
 * 影调 1 / 视角 1 / 构图 1 / 景别 1 / 类型 1；每路 s ∈ [0,1]，仅两侧都有效才计入
 * （不进分子也不进分母）。
 */
import { hammingHex } from "../../../core/imaging/phash";
import { hexToRgb, rgbToLab, labDistance } from "../../../core/imaging/color";
import { bigramDice } from "./rank";
import type { LibraryIndexItem } from "../index/indexFile";

export interface SimilarResult {
  item: LibraryIndexItem;
  /** 可用信号加权平均 S = Σw·s / Σw */
  score: number;
  /** 贡献（w×s）top-2 的理由标签；并列按信号表序 */
  reasons: string[];
}

const RESULT_LIMIT = 12;
/** pHash 软门控：h > 24 整路缺席（不是计零） */
const PHASH_SOFT_GATE = 24;
/** S 低于此值剔除 */
const SCORE_FLOOR = 0.25;
/** 主色 Lab 匹配的归一化距离范围（40 = 1 − d/40 的零点） */
const COLOR_LAB_RANGE = 40;

/** 影调档位映射：low/mid/high → 0/1/2 */
const TONE_LEVEL: Record<string, number> = { low: 0, mid: 1, high: 2 };

/* ---- fields 防御解析（fields 是 Record<string, unknown>，不引新依赖） ---- */

/** 仅接受非空字符串，否则视为缺席 */
function strField(item: LibraryIndexItem, key: string): string | null {
  const v = item.fields[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** 仅接受「数组且每项含 string term + number conf」的形状，逐项校验，任一不合视为缺席 */
function topKField(
  item: LibraryIndexItem,
  key: string,
): Array<{ term: string; conf: number }> | null {
  const v = item.fields[key];
  if (!Array.isArray(v)) return null;
  const out: Array<{ term: string; conf: number }> = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) return null;
    const rec = e as { term?: unknown; conf?: unknown };
    if (typeof rec.term !== "string" || rec.term.length === 0) return null;
    if (typeof rec.conf !== "number" || !Number.isFinite(rec.conf)) return null;
    out.push({ term: rec.term, conf: rec.conf });
  }
  return out;
}

/* ---- 主色调色板（对称最近 Lab 匹配） ---- */

interface LabColor {
  ratio: number;
  L: number;
  a: number;
  b: number;
}

function paletteToLab(colors: Array<{ hex: string; ratio: number }>): LabColor[] | null {
  if (colors.length === 0) return null;
  const out: LabColor[] = [];
  for (const c of colors) {
    const rgb = hexToRgb(c.hex);
    if (!rgb) continue;
    const lab = rgbToLab(rgb.r, rgb.g, rgb.b);
    out.push({ ratio: c.ratio, L: lab.L, a: lab.a, b: lab.b });
  }
  return out.length > 0 ? out : null;
}

/** 单侧：Σ ratio_i × max_j max(0, 1 − dist(i,j)/40)（ratio 按原值加权，不归一化） */
function paletteSide(from: LabColor[], to: LabColor[]): number {
  let sum = 0;
  for (const ca of from) {
    let best = 0;
    for (const cb of to) {
      const v = Math.max(0, 1 - labDistance(ca, cb) / COLOR_LAB_RANGE);
      if (v > best) best = v;
    }
    sum += ca.ratio * best;
  }
  return sum;
}

/** 对称后取均值；任一色板为空 → 由调用方整路缺席 */
function paletteScore(a: LabColor[], b: LabColor[]): number {
  return (paletteSide(a, b) + paletteSide(b, a)) / 2;
}

/** top-k 数组共有 term：s = min(1, Σ_shared min(confA, confB)) */
function topKScore(
  a: Array<{ term: string; conf: number }>,
  b: Array<{ term: string; conf: number }>,
): number {
  const confA = new Map<string, number>();
  for (const e of a) confA.set(e.term, e.conf);
  let sum = 0;
  for (const e of b) {
    const ca = confA.get(e.term);
    if (ca !== undefined) sum += Math.min(ca, e.conf);
  }
  return Math.min(1, sum);
}

/* ---- 目标解析结果（循环外算一次，循环内只解析候选） ---- */

interface SimilarTarget {
  lab: LabColor[] | null;
  tags: Set<string> | null; // null = 无 tag（缺席）
  phash: string | null;
  scene: string | null; // 已小写
  subject: string | null; // 已小写
  tone: number | null;
  angle: Array<{ term: string; conf: number }> | null;
  composition: Array<{ term: string; conf: number }> | null;
  shot: Array<{ term: string; conf: number }> | null;
  contentType: string | null;
}

function parseTarget(item: LibraryIndexItem): SimilarTarget {
  return {
    lab: paletteToLab(item.colors),
    tags: item.tags.length > 0 ? new Set(item.tags.map((t) => t.text)) : null,
    phash: item.phash,
    scene: strField(item, "scene")?.toLowerCase() ?? null,
    subject: strField(item, "subject")?.toLowerCase() ?? null,
    tone: item.tone != null ? (TONE_LEVEL[item.tone] ?? null) : null,
    angle: topKField(item, "angle"),
    composition: topKField(item, "composition"),
    shot: topKField(item, "shot"),
    contentType: strField(item, "content_type"),
  };
}

/* ---- 候选信号表（顺序 = 理由并列决胜序；每路仅两侧都有效才入表） ---- */

interface Signal {
  label: string;
  weight: number;
  score: number;
}

function signalsOf(t: SimilarTarget, c: LibraryIndexItem): Signal[] {
  const out: Signal[] = [];

  // 色彩（主色调色板，权重 3）：对称最近 Lab 匹配
  if (t.lab) {
    const clab = paletteToLab(c.colors);
    if (clab) out.push({ label: "色彩", weight: 3, score: paletteScore(t.lab, clab) });
  }

  // 标签（权重 3）：Jaccard |∩|/|∪|，text 集合，manual/auto 不分源
  if (t.tags) {
    if (c.tags.length > 0) {
      const shared = c.tags.filter((tg) => t.tags!.has(tg.text)).length;
      const union = t.tags.size + c.tags.length - shared;
      out.push({ label: "标签", weight: 3, score: shared / union });
    }
  }

  // 轮廓（pHash，权重 2）：两侧 phash 非空且 h ≤ 24 → s = 1 − h/64；h>24 或缺任一侧 → 缺席
  if (t.phash && c.phash) {
    const h = hammingHex(t.phash, c.phash);
    if (h <= PHASH_SOFT_GATE) {
      out.push({ label: "轮廓", weight: 2, score: 1 - h / 64 });
    }
  }

  // 场景（权重 2）/ 主体（权重 1）：bigramDice（两侧非空字符串才参与）
  if (t.scene) {
    const s = strField(c, "scene");
    if (s) out.push({ label: "场景", weight: 2, score: bigramDice(t.scene, s.toLowerCase()) });
  }
  if (t.subject) {
    const s = strField(c, "subject");
    if (s) out.push({ label: "主体", weight: 1, score: bigramDice(t.subject, s.toLowerCase()) });
  }

  // 影调（权重 1）：low/mid/high → 0/1/2，s = 1 − |档差|/2；任一侧 tone 为 null → 缺席
  if (t.tone !== null) {
    const ct = c.tone != null ? TONE_LEVEL[c.tone] : undefined;
    if (ct !== undefined) {
      out.push({ label: "影调", weight: 1, score: 1 - Math.abs(t.tone - ct) / 2 });
    }
  }

  // 视角 / 构图 / 景别（权重各 1）：top-k 数组共有 term
  if (t.angle) {
    const ca = topKField(c, "angle");
    if (ca) out.push({ label: "视角", weight: 1, score: topKScore(t.angle, ca) });
  }
  if (t.composition) {
    const cc = topKField(c, "composition");
    if (cc) out.push({ label: "构图", weight: 1, score: topKScore(t.composition, cc) });
  }
  if (t.shot) {
    const cs = topKField(c, "shot");
    if (cs) out.push({ label: "景别", weight: 1, score: topKScore(t.shot, cs) });
  }

  // 类型（权重 1）：两侧非空字符串，相等 1、不等 0
  if (t.contentType) {
    const ct = strField(c, "content_type");
    if (ct) out.push({ label: "类型", weight: 1, score: t.contentType === ct ? 1 : 0 });
  }

  return out;
}

/**
 * 多信号加权相似图（参数化内核）：无硬阈值一票否决；只统计两侧都有数据
 * 的信号；S = Σw·s/Σw，S < floor 剔除；按 S 降序、平分按 mtime 降序；取前 limit。
 */
export function findSimilarWith(
  target: LibraryIndexItem,
  items: LibraryIndexItem[],
  floor: number,
  limit: number,
): SimilarResult[] {
  const t = parseTarget(target);
  const out: SimilarResult[] = [];

  for (const c of items) {
    if (c.id === target.id) continue;
    const sigs = signalsOf(t, c);
    if (sigs.length === 0) continue;
    let sum = 0;
    let wsum = 0;
    for (const s of sigs) {
      sum += s.weight * s.score;
      wsum += s.weight;
    }
    const score = sum / wsum;
    if (score < floor) continue;
    // 贡献（w×s）top-2；并列按信号表序（sigs 即表序，sort 稳定）
    const reasons = [...sigs]
      .sort((x, y) => y.weight * y.score - x.weight * x.score)
      .slice(0, 2)
      .map((s) => s.label);
    out.push({ item: c, score, reasons });
  }

  out.sort((a, b) => b.score - a.score || b.item.mtime - a.item.mtime);
  return out.slice(0, limit);
}

/**
 * 详情页相似图（口径不变）：S < 0.25 剔除，取前 12。
 */
export function findSimilar(
  target: LibraryIndexItem,
  items: LibraryIndexItem[],
): SimilarResult[] {
  return findSimilarWith(target, items, SCORE_FLOOR, RESULT_LIMIT);
}
