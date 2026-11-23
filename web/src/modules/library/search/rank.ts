/**
 * M3.4 检索打分引擎（口径钉死，任务卡 2026-08-08-M3.4 §4.3 + M3.4.5 双引擎）。
 * 纯函数、零 React 依赖：筛选器全 AND → 幸存条目再跑文本打分；
 * 温度映射（门槛/同义展开/部分命中/漏词规则）、字段权重、命中理由。
 * 双引擎（M3.4.5，任务卡 2026-09-05-M3.4.5）：
 * - 词典轨（现状，semantic 为 undefined）：token 轨 + NL 轨（naturalLanguageScore）；
 * - 向量轨（semantic 传入时，搜索引擎=向量且 Ollama 在线）：cos 余弦阈值保留 +
 *   vectorScore 排序，NL 轨停用；向量命中理由「语义·NN%」。
 *   词典模式行为与引入向量轨之前逐字节一致（回归高压线）。
 */
import { hexToRgb, labDistance, rgbToLab } from "../../../core/imaging/color";
import type { LibraryIndexItem } from "../index/indexFile";
import { expandSynonyms } from "./synonyms";

export interface SearchCriteria {
  query: string; // 已 trim 的原始输入，可为 ""
  temperature: number; // 0–5 整数
  activeTags: string[]; // tag 云选中
  tagMode: "and" | "or";
  toneFilter: Array<"low" | "mid" | "high">; // 空 = 不限
  warmthFilter: Array<"warm" | "cool" | "neutral">; // 空 = 不限
  colorFilter: ColorFilter | null;
  folderScope: string | null; // 如 "night" 或 "night/river"，不含首尾斜杠
  starredOnly: boolean; // 仅标星
}

/** 取色组：一个托盘内的颜色集合 + 组内逻辑（and = 每色都需命中，or = 任一命中） */
export interface ColorGroup {
  mode: "and" | "or";
  colors: string[];
}

/**
 * 取色筛选（2026-08 用户改版二）：三个取色托盘 + 两级逻辑。
 * row = 取色行（粗略直配，对色板主色 colors）；hi = 高光（对 hiColor）；
 * lo = 阴影（对 loColor）。组内颜色按各组的 mode 取交集/并集；
 * 组间按 filter.mode 取交集/并集；空组不参与（模式可预设，空托盘不构成约束）。
 */
export interface ColorFilter {
  mode: "and" | "or"; // 三个托盘之间
  row: ColorGroup;
  hi: ColorGroup;
  lo: ColorGroup;
}

export interface SearchHit {
  score: number;
  matchedTags: string[]; // 命中的 tag 文本（高亮用）
  reasons: string[]; // 命中理由
}

export interface SearchResult {
  items: LibraryIndexItem[]; // 排序后
  hits: Map<string, SearchHit>; // key = item.id；无文本查询时为空 Map
}

interface TempSpec {
  threshold: number;
  hop: 0 | 1 | 2;
  bigram: boolean;
  missingAllowed: boolean;
}

const TEMPERATURES: Record<number, TempSpec> = {
  0: { threshold: 2.0, hop: 0, bigram: false, missingAllowed: false },
  1: { threshold: 1.6, hop: 1, bigram: false, missingAllowed: false },
  2: { threshold: 1.2, hop: 1, bigram: true, missingAllowed: false },
  3: { threshold: 0.8, hop: 1, bigram: true, missingAllowed: true },
  4: { threshold: 0.5, hop: 2, bigram: true, missingAllowed: true },
  5: { threshold: 0.3, hop: 2, bigram: true, missingAllowed: true },
};

/**
 * 向量轨温度 → 余弦阈值表（M3.4.5，A 复核 M3.4.4 PoC §4.3 后钉死，t0 最严 → t5 最松）：
 * t0=0.56 / t1=0.55 / t2=0.54 / t3=0.52 / t4=0.51 / t5=0.50
 * 依据见 .tools/shots/m34vector-poc-report.md §4.3（top1 得分下限 0.5742 与
 * top10 末位下限 0.5166 向下取 0.01，等距插值 5 档）。
 */
export const VECTOR_TEMP_THRESHOLDS = [0.56, 0.55, 0.54, 0.52, 0.51, 0.50];

/** 向量轨语义计分器：返回归一化点积（0..1）或 null（该条目无向量/文档空，向量轨不参与） */
export interface SemanticScorer {
  score(query: string, item: LibraryIndexItem): number | null;
}

/**
 * 图片扩展名后缀（与 scan.ts 白名单一致，M3.4.2 R3-2）：
 * query token 以扩展名结尾 → 剥离后再参与匹配（basename 已去扩展名，不剥离则直配失败）。
 */
const IMAGE_EXT_SUFFIX_RE = /\.(?:jpg|jpeg|png|webp|gif|bmp|avif)$/i;
function stripImageExt(token: string): string {
  return token.replace(IMAGE_EXT_SUFFIX_RE, "");
}

/** 编辑距离（小 DP，不引依赖） */
function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i += 1) {
    const cur = new Array<number>(lb + 1);
    cur[0] = i;
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[lb];
}

/** 字符级 bigram 集合；长度 1 的串退化为单字符集合 */
function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length === 1) {
    out.add(text);
    return out;
  }
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

/** bigram Dice 相似度：2|A∩B| / (|A|+|B|) */
export function bigramDice(a: string, b: string): number {
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  return (2 * inter) / (sa.size + sb.size);
}

function hexToLab(hex: string): { L: number; a: number; b: number } | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToLab(rgb.r, rgb.g, rgb.b) : null;
}

/** 取色 Lab 距离阈值：10 + 5×t；t=3（默认）为 25，与旧口径一致 */
export function colorThreshold(temperature: number): number {
  return 10 + 5 * Math.min(5, Math.max(0, Math.round(temperature)));
}

/** 冷暖 W 阈值表：|W| 超过阈值才算暖/冷；t=3（默认）为 8，与旧口径一致 */
const WARMTH_THRESHOLDS: Record<number, number> = {
  0: 20,
  1: 16,
  2: 12,
  3: 8,
  4: 5,
  5: 3,
};

/** Lab 判定：目标或候选任一非法返回 false；阈值随温度缩放 */
function near(
  target: { L: number; a: number; b: number } | null,
  hex: string | undefined,
  threshold: number,
): boolean {
  if (!target || !hex) return false;
  const lab = hexToLab(hex);
  return lab ? labDistance(target, lab) <= threshold : false;
}

/** 冷暖：W = Σ (r − b) × ratio；|W| 超阈值才算暖/冷（阈值随温度缩放）；colors 空 → neutral */
function warmthOf(
  item: LibraryIndexItem,
  threshold: number,
): "warm" | "cool" | "neutral" {
  let w = 0;
  for (const c of item.colors) {
    const rgb = hexToRgb(c.hex);
    if (!rgb) continue;
    w += (rgb.r - rgb.b) * c.ratio;
  }
  if (w > threshold) return "warm";
  if (w < -threshold) return "cool";
  return "neutral";
}

/** 取色组命中：组内每色对对应分区做 Lab 匹配（阈值随温度缩放），组内按 mode 取交集/并集；空组 true */
function groupMatch(
  item: LibraryIndexItem,
  group: ColorGroup,
  kind: "row" | "hi" | "lo",
  threshold: number,
): boolean {
  if (group.colors.length === 0) return true;
  const zoneMatch = (hex: string): boolean => {
    const target = hexToLab(hex);
    if (!target) return false;
    if (kind === "row") {
      return item.colors.some((col) => near(target, col.hex, threshold));
    }
    const rep = kind === "hi" ? item.hiColor?.hex : item.loColor?.hex;
    return near(target, rep, threshold);
  };
  return group.mode === "and"
    ? group.colors.every(zoneMatch)
    : group.colors.some(zoneMatch);
}

/**
 * 标签命中（温度门控，2026-08 用户口径；M3.4.1 起与文本打分同口径）：
 * t=0 精确子串；t≥1 同义展开（1 跳，t≥4 二跳）；
 * t≥2 放开编辑距离（候选 ≥3 字、≤1 字差）与 bigram Dice（≥0.34）模糊，文本打分同口径。
 */
function tagHit(item: LibraryIndexItem, activeTag: string, temp: TempSpec): boolean {
  const candidates = candidatesOf(activeTag.toLowerCase(), temp);
  for (const tag of item.tags) {
    const s = tag.text.toLowerCase();
    for (const cand of candidates) {
      const c = cand.text;
      if (s.includes(c)) return true;
      if (!temp.bigram) continue; // t≥2 才放开模糊
      if (
        Math.abs(c.length - s.length) <= 1 &&
        c.length >= 3 && // 候选 ≥3 字才容错（M3.4.1，与 matchField 同口径）
        levenshtein(c, s) <= 1
      ) {
        return true;
      }
      if (bigramDice(c, s) >= 0.34) return true;
    }
  }
  return false;
}

/** 筛选器（全部 AND；各自为空/null 时不限；温度同步控制各筛选精度） */
function passesFilters(item: LibraryIndexItem, c: SearchCriteria): boolean {
  const temp = TEMPERATURES[Math.min(5, Math.max(0, Math.round(c.temperature)))];
  if (c.folderScope && !item.relPath.startsWith(`${c.folderScope}/`)) return false;
  if (c.starredOnly && !item.starred) return false;
  if (c.toneFilter.length > 0 && (item.tone == null || !c.toneFilter.includes(item.tone))) {
    return false;
  }
  if (
    c.warmthFilter.length > 0 &&
    !c.warmthFilter.includes(warmthOf(item, WARMTH_THRESHOLDS[Math.min(5, Math.max(0, Math.round(c.temperature)))]))
  ) {
    return false;
  }
  if (c.activeTags.length > 0) {
    const hit =
      c.tagMode === "and"
        ? c.activeTags.every((t) => tagHit(item, t, temp))
        : c.activeTags.some((t) => tagHit(item, t, temp));
    if (!hit) return false;
  }
  if (c.colorFilter) {
    const f = c.colorFilter;
    const threshold = colorThreshold(c.temperature);
    // 三托盘组内各自判定；组间按 mode 取交集/并集；空组不参与
    const checks: boolean[] = [];
    if (f.row.colors.length > 0) checks.push(groupMatch(item, f.row, "row", threshold));
    if (f.hi.colors.length > 0) checks.push(groupMatch(item, f.hi, "hi", threshold));
    if (f.lo.colors.length > 0) checks.push(groupMatch(item, f.lo, "lo", threshold));
    if (checks.length > 0) {
      const ok = f.mode === "and" ? checks.every(Boolean) : checks.some(Boolean);
      if (!ok) return false;
    }
  }
  return true;
}

interface Field {
  s: string; // 匹配串（tags/basename 已小写；subject/description/note 按原文）
  label: string; // 命中理由（直配且 factor=1 时）
  tagText: string | null; // tags 字段的原始 tag 文本（matchedTags 用）
  weight: number;
  /** M3.4.2 R3 双轨（2026-08-31 用户定稿）：true = 文件名轨——只做原始 token 子串直配
   *  （无同义展开/编辑距离/bigram、不随温度，命中即 weight 分）；false = 自然语言轨。 */
  exact?: boolean;
}

function fieldsOf(item: LibraryIndexItem): Field[] {
  const fields: Field[] = [];
  for (const t of item.tags) {
    fields.push({ s: t.text.toLowerCase(), label: `标签·${t.text}`, tagText: t.text, weight: 3 });
  }
  const subject = String(item.fields.subject ?? "");
  if (subject) fields.push({ s: subject, label: "主题", tagText: null, weight: 3 });
  // M3.4.3 R1（对 M3.4 §4.3 字段表的修订，A 批准）：scene = M3.5 识图核心字段，
  // 与 subject(w3) 同族入表，w2；token 轨与 NL 轨同生效
  const scene = String(item.fields.scene ?? "");
  if (scene) fields.push({ s: scene, label: "场景", tagText: null, weight: 2 });
  const dot = item.relPath.lastIndexOf(".");
  const base = dot >= 0 ? item.relPath.slice(0, dot) : item.relPath;
  const basename = base.slice(base.lastIndexOf("/") + 1).toLowerCase();
  if (basename) fields.push({ s: basename, label: "文件名", tagText: null, weight: 2, exact: true });
  if (item.description) fields.push({ s: item.description, label: "描述", tagText: null, weight: 2 });
  if (item.note) fields.push({ s: item.note, label: "备注", tagText: null, weight: 1 });
  return fields;
}

function matchField(
  cand: { text: string; factor: number },
  field: Field,
  temp: TempSpec,
): { score: number; reason: string } | null {
  const c = cand.text;
  const s = field.s;
  if (s.includes(c)) {
    return {
      score: field.weight * cand.factor,
      reason: cand.factor < 1 ? `联想·${c}` : field.label,
    };
  }
  // 编辑距离与 bigram 同属模糊匹配，t≥2 才放开（与 tagHit 同口径，M3.4.1）；
  // 候选需 ≥3 字：双字词差 1 字 = 50% 差异，误伤率过高（风光≈逆光/人物≈静物）。
  if (
    temp.bigram &&
    Math.abs(c.length - s.length) <= 1 &&
    c.length >= 3 &&
    levenshtein(c, s) <= 1
  ) {
    return { score: 0.8 * field.weight * cand.factor, reason: `模糊·${c}` };
  }
  if (temp.bigram) {
    const dice = bigramDice(c, s);
    if (dice >= 0.34) {
      return { score: 0.6 * field.weight * dice * cand.factor, reason: `模糊·${c}` };
    }
  }
  return null;
}

function candidatesOf(token: string, temp: TempSpec): Array<{ text: string; factor: number }> {
  const out: Array<{ text: string; factor: number }> = [{ text: token, factor: 1 }];
  const seen = new Set([token]);
  if (temp.hop >= 1) {
    for (const w of expandSynonyms(token, 1)) {
      if (!seen.has(w)) {
        seen.add(w);
        out.push({ text: w, factor: 0.8 });
      }
    }
  }
  if (temp.hop >= 2) {
    for (const w of expandSynonyms(token, 2)) {
      if (!seen.has(w)) {
        seen.add(w);
        out.push({ text: w, factor: 0.5 });
      }
    }
  }
  return out;
}

interface NlContribution {
  label: string;
  cover: number;
  score: number; // field.weight × cover（排序用）
  tagText: string | null;
}

/**
 * M3.4.3 自然语言轨（口径来源 2026-08-31 用户：自然语言找图是温度控件的意义；
 * 文件名无联想走 exact 轨）。公式（钉死）：
 *  触发：query 去全部空白后 ≥5 字（bigram 数 ≥4）；否则 NL 分 = 0。
 *  查询集 Bq = bigrams(小写去空白 query)。
 *  同义扩展：Bq 中每个“作为词存在”于词典的 bigram w（expandSynonyms(w,1) 非空即在典）
 *    → t≥1（temp.hop≥1）加入 1 跳同义词的 bigram（factor 0.8）、t≥4（hop≥2）加 2 跳
 *    （factor 0.5）；扩展集与 Bq 去重、每个扩展 bigram 取最优 factor 计一次。
 *  字段覆盖：对每个字段（含 tags 逐 tag；exact 字段在 NL 轨按普通字段参与，权重不变）：
 *    hits = |Bq ∩ bigrams(field.s)|；extHits = Σ(出现在 field bigrams 的扩展 bigram 的 factor)；
 *    cover = min(1, (hits+extHits)/|Bq|)；fieldScore = weight × cover。
 *  NL 总分 = Σ 各字段 fieldScore；保留判定 nlScore ≥ temp.threshold（与 token 轨共用门槛表）。
 */
function naturalLanguageScore(
  query: string,
  fields: Field[],
  temp: TempSpec,
): { score: number; contributions: NlContribution[] } {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (q.length < 5) return { score: 0, contributions: [] };
  const bq = bigrams(q);
  if (bq.size === 0) return { score: 0, contributions: [] };
  // 同义扩展（词典 bigram 级）：best factor per ext bigram
  const ext = new Map<string, number>();
  if (temp.hop >= 1 || temp.hop >= 2) {
    for (const w of bq) {
      if (expandSynonyms(w, 1).length === 0) continue; // 非词典词不在典
      if (temp.hop >= 1) {
        for (const s of expandSynonyms(w, 1)) {
          for (const b of bigrams(s)) ext.set(b, Math.max(ext.get(b) ?? 0, 0.8));
        }
      }
      if (temp.hop >= 2) {
        for (const s of expandSynonyms(w, 2)) {
          for (const b of bigrams(s)) ext.set(b, Math.max(ext.get(b) ?? 0, 0.5));
        }
      }
    }
    for (const b of bq) ext.delete(b); // 已是原生 bigram 的不重复计
  }
  const denom = bq.size;
  let score = 0;
  const contributions: NlContribution[] = [];
  for (const field of fields) {
    const fb = bigrams(field.s.toLowerCase());
    if (fb.size === 0) continue;
    let hits = 0;
    for (const b of bq) if (fb.has(b)) hits += 1;
    let extHits = 0;
    for (const [b, f] of ext) if (fb.has(b)) extHits += f;
    const cover = Math.min(1, (hits + extHits) / denom);
    const fieldScore = field.weight * cover;
    if (cover > 0) {
      score += fieldScore;
      contributions.push({ label: field.label, cover, score: fieldScore, tagText: field.tagText });
    }
  }
  return { score, contributions };
}

/**
 * M3.4.5 双引擎搜索：
 * - semantic 为 undefined（词典引擎 / Ollama 离线）→ 现状路径逐字节不变
 *   （token 轨 + NL 轨，M3.4.3 口径）；
 * - semantic 传入且 query 去空白 ≥2 字 → 向量轨启用：
 *   cos = semantic.score(query, item)，null（条目无向量/文档空）→ 向量轨不参与；
 *   保留：cos ≥ VECTOR_TEMP_THRESHOLDS[temp]；向量分 vectorScore = (cos−0.40)×10；
 *   top-k 上限：向量轨保留超 200 条只留按 cos 降序前 200（防平庸灌水）；
 *   item 总分 = max(token 轨 total, vectorScore)（exact 文件名轨照常进 token total，
 *   不受影响）；保留判定 = token 轨过 **或** 向量轨过；向量模式下 NL 轨停用；
 *   向量命中理由「语义·NN%」。
 */
export function searchItems(
  items: LibraryIndexItem[],
  criteria: SearchCriteria,
  semantic?: SemanticScorer,
): SearchResult {
  const query = criteria.query.trim();
  // M3.4.2 R3 双轨：温度只作用于自然语言轨（tags/subject/description/note 的同义/模糊门控）；
  // 文件名轨（basename exact 字段）直配不随温度。query token 以扩展名结尾先剥离（R3-2）。
  const temp = TEMPERATURES[Math.min(5, Math.max(0, Math.round(criteria.temperature)))];
  const tempIndex = Math.min(5, Math.max(0, Math.round(criteria.temperature)));
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => stripImageExt(token))
    .filter(Boolean);
  // 向量轨启用条件：semantic 存在 且 query 去空白 ≥2 字（R5.3）
  const vectorMode = semantic != null && query.replace(/\s+/g, "").length >= 2;

  const survivors = items.filter((item) => passesFilters(item, criteria));
  if (tokens.length === 0) {
    return { items: survivors, hits: new Map() };
  }

  const hits = new Map<string, SearchHit>();
  const scored: Array<{ item: LibraryIndexItem; total: number }> = [];
  // 向量轨候选（保留需先过 top-200 上限，故延后到循环外定稿）
  const vectorCands: Array<{
    item: LibraryIndexItem;
    cos: number;
    tokenTotal: number;
    tokenKeeps: boolean;
    reasons: Set<string>;
    matchedTags: Set<string>;
  }> = [];
  for (const item of survivors) {
    const fields = fieldsOf(item);
    let total = 0;
    const reasons = new Set<string>();
    const matchedTags = new Set<string>();
    let allHit = true;
    let anyHit = false;
    for (const token of tokens) {
      let best = 0;
      const bestCombos: Array<{ reason: string; tagText: string | null }> = [];
      // 文件名轨（exact 字段）：只做原始 token 子串直配——跳过候选同义展开与 matchField
      // 模糊分支、不随温度，命中即 weight 分（M3.4.2 R3，2026-08-31 用户口径）
      for (const field of fields) {
        if (!field.exact) continue;
        if (field.s.includes(token)) {
          const score = field.weight;
          if (score > best + 0.01) {
            best = score;
            bestCombos.length = 0;
            bestCombos.push({ reason: field.label, tagText: null });
          } else if (Math.abs(score - best) <= 0.01) {
            bestCombos.push({ reason: field.label, tagText: null });
          }
        }
      }
      // 自然语言轨（非 exact 字段）：候选（温度同义展开）× matchField（模糊/门槛维持 M3.4.1）
      for (const cand of candidatesOf(token, temp)) {
        for (const field of fields) {
          if (field.exact) continue;
          const m = matchField(cand, field, temp);
          if (!m) continue;
          if (m.score > best + 0.01) {
            best = m.score;
            bestCombos.length = 0;
            bestCombos.push({ reason: m.reason, tagText: field.tagText });
          } else if (Math.abs(m.score - best) <= 0.01) {
            bestCombos.push({ reason: m.reason, tagText: field.tagText });
          }
        }
      }
      if (best > 0) {
        anyHit = true;
        total += best;
        for (const combo of bestCombos) {
          reasons.add(combo.reason);
          if (combo.tagText) matchedTags.add(combo.tagText);
        }
      } else {
        allHit = false;
      }
    }
    const tokenKeeps = (temp.missingAllowed ? anyHit : allHit) && total >= temp.threshold;

    if (!vectorMode) {
      // ---- 词典引擎（现状逐字节保留）：token 轨 + NL 轨 ----
      // M3.4.3 自然语言轨：query ≥5 字时按 bigram 覆盖率独立算分（含温度同义扩展）；
      // 两轨取 max、保留判定 = 任一轨过门槛（token 轨维持 missingAllowed/allHit 口径）
      const nl = naturalLanguageScore(query, fields, temp);
      const totalScore = Math.max(total, nl.score);
      const nlKeeps = nl.score >= temp.threshold;
      if (tokenKeeps || nlKeeps) {
        if (nlKeeps && nl.contributions.length > 0) {
          // 理由：NL 贡献字段 cover ≥ 15% 的前 2（按字段分降序）；tag 命中进 matchedTags。
          // A 裁定补口径（2026-09-03）：命中不许无理由——若全部贡献 cover < 15%，
          // 保底显示贡献最高的 1 条（覆盖百分比照实显示，可能 <15%）
          let top = [...nl.contributions]
            .filter((c) => c.cover >= 0.15)
            .sort((a, b) => b.score - a.score)
            .slice(0, 2);
          if (top.length === 0) {
            top = [...nl.contributions].sort((a, b) => b.score - a.score).slice(0, 1);
          }
          for (const c of top) reasons.add(`${c.label}·覆盖 ${Math.round(c.cover * 100)}%`);
          for (const c of nl.contributions) if (c.tagText) matchedTags.add(c.tagText);
        }
        scored.push({ item, total: totalScore });
        hits.set(item.id, {
          score: totalScore,
          matchedTags: [...matchedTags],
          reasons: [...reasons],
        });
      }
      continue;
    }

    // ---- 向量引擎：cos 阈值保留（NL 轨停用）----
    const cos = semantic!.score(query, item);
    if (cos == null) {
      // 条目无向量（未嵌入/文档空）：向量轨不参与，仅 token 轨可保留
      if (tokenKeeps) {
        scored.push({ item, total });
        hits.set(item.id, {
          score: total,
          matchedTags: [...matchedTags],
          reasons: [...reasons],
        });
      }
      continue;
    }
    if (cos >= VECTOR_TEMP_THRESHOLDS[tempIndex]) {
      vectorCands.push({ item, cos, tokenTotal: total, tokenKeeps, reasons, matchedTags });
    } else if (tokenKeeps) {
      // 向量未过阈但 token 轨保留：走 token 分（向量分 < 阈不参与排序）
      scored.push({ item, total });
      hits.set(item.id, {
        score: total,
        matchedTags: [...matchedTags],
        reasons: [...reasons],
      });
    }
  }

  // 向量轨 top-200 上限：按 cos 降序只留前 200；超出的候选回到 token 轨判定
  vectorCands.sort((a, b) => b.cos - a.cos);
  const vectorFinal = vectorCands.slice(0, 200);
  const vectorDropped = vectorCands.slice(200);
  for (const cand of vectorFinal) {
    const vectorScore = (cand.cos - 0.4) * 10;
    const totalScore = Math.max(cand.tokenTotal, vectorScore);
    cand.reasons.add(`语义·${Math.round(cand.cos * 100)}%`);
    scored.push({ item: cand.item, total: totalScore });
    hits.set(cand.item.id, {
      score: totalScore,
      matchedTags: [...cand.matchedTags],
      reasons: [...cand.reasons],
    });
  }
  for (const cand of vectorDropped) {
    if (!cand.tokenKeeps) continue;
    scored.push({ item: cand.item, total: cand.tokenTotal });
    hits.set(cand.item.id, {
      score: cand.tokenTotal,
      matchedTags: [...cand.matchedTags],
      reasons: [...cand.reasons],
    });
  }

  scored.sort((a, b) => b.total - a.total || b.item.mtime - a.item.mtime);
  return { items: scored.map((x) => x.item), hits };
}
