/**
 * M3.5.1 云端识图 · 容错 JSON 解析与字段归一化（任务卡 §4.7 算法钉死）。
 * 解析管线：提取 → 全角修复 → JSON.parse（失败截断修复循环）→ 归一化 + tag 清洗。
 * 任何步骤抛错带原始 text 前 200 字符进 Error.message（定位用）。
 */

import { BUILTIN_FIELDS, type VisionFieldDef } from "./fieldSchema";

export interface VisionParsed {
  description: string;
  /** 启用的内置语义字段（subject/scene/lighting/angle/composition/shot/color_mood/mood_style/content_type 中实际产出且通过校验的） */
  fields: Record<string, unknown>;
  /** 自定义字段产出（→ item.extra） */
  custom: Record<string, unknown>;
  /** 清洗后 */
  tags: string[];
}

const BUILTIN_KEYS = new Set(BUILTIN_FIELDS.map((f) => f.key));

/** 丢弃标记：enum 词表外 / top-k 结果为空时该字段不进结果 */
const DROP = Symbol("drop");

/** 全角修复映射（顺序钉死） */
const FULLWIDTH: Record<string, string> = {
  "，": ",",
  "：": ":",
  "；": ";",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "｛": "{",
  "｝": "}",
  "［": "[",
  "］": "]",
};

/**
 * 全角修复（裁定 A：仅字符串外生效）：扫描跟踪 inString/转义（范本同
 * findLastComma），只在字符串外应用 FULLWIDTH 映射；字符串值内部的全角标点
 * 原样保留。仍在提取步骤之前对全文执行（5.1 裁定 1 固化）。
 */
function fixFullwidth(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    out += FULLWIDTH[ch] ?? ch;
  }
  return out;
}

/** 步骤 1：找首个 `{`；无则抛错；有最后一个 `}` 截首尾区间，否则取首 `{` 到结尾（截断路径） */
function extractCandidate(text: string): string {
  const first = text.indexOf("{");
  if (first === -1) throw new Error("响应中找不到 JSON 对象起始");
  const last = text.lastIndexOf("}");
  return last > first ? text.slice(first, last + 1) : text.slice(first);
}

/**
 * 扫描当前串（跟踪 inString/转义/开闭括号栈），找最后一个「不在字符串内的 ,」
 * 位置及其括号栈快照；无则返回 null。
 */
function findLastComma(
  text: string,
): { index: number; stack: string[] } | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let found: { index: number; stack: string[] } | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      if ((ch === "}" && top === "{") || (ch === "]" && top === "[")) stack.pop();
      continue;
    }
    if (ch === ",") found = { index: i, stack: [...stack] };
  }
  return found;
}

/** 按栈逆序补闭括号（{→}、[→]） */
function closeOpenBrackets(prefix: string, stack: string[]): string {
  let out = prefix;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out += stack[i] === "{" ? "}" : "]";
  }
  return out;
}

/**
 * 步骤 2–3：JSON.parse；失败则截断修复循环（至多 20 轮）：
 * 截到最后一个「不在字符串内的 ,」，按栈逆序补闭括号再试；找不到逗号则抛错。
 * 全角修复已在入口（提取前）对全文执行——否则纯全角包裹的响应（如验收用例 1）
 * 在提取步骤就找不到 `{`。
 */
function parseJson(text: string): Record<string, unknown> {
  let attempt = text;
  for (let round = 0; round <= 20; round += 1) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("JSON 顶层不是对象");
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (round === 20) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
    const cut = findLastComma(attempt);
    if (!cut) throw new Error("无法修复截断 JSON：找不到可截断的逗号");
    attempt = closeOpenBrackets(attempt.slice(0, cut.index), cut.stack);
  }
  throw new Error("截断修复失败");
}

function clampConf(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(1, Math.max(0, v));
  }
  return 0.5;
}

/**
 * tags 清洗（顺序钉死）：逐项 String(x).trim() → 去空 → 含 `:` 或 `：` 丢弃 →
 * 截断到 30 字符 → 去重 → 取前 10。非数组按空处理。
 */
function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const text = String(item).trim();
    if (!text) continue;
    if (text.includes(":") || text.includes("：")) continue;
    const cut = text.length > 30 ? text.slice(0, 30) : text;
    if (seen.has(cut)) continue;
    seen.add(cut);
    out.push(cut);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * top-k 数组归一化（enum_top2/3 与带 topK 的自定义 enum 共用，裁定 B）：
 * 数组项取 {term, conf}；term ∉ options 丢弃；conf 钳制 [0,1]（非数按 0.5）；
 * 保序切 topK；结果为空则 DROP。
 */
function normalizeTopK(
  value: unknown,
  topK: number,
  options: string[],
): unknown {
  if (!Array.isArray(value)) return DROP;
  const items: Array<{ term: string; conf: number }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const term = (entry as { term?: unknown }).term;
    if (typeof term !== "string" || !options.includes(term)) continue;
    // conf 钳制 [0,1]（非数按 0.5）；conf<0.3 的筛选在后续筛选层做，这里原样保留
    items.push({ term, conf: clampConf((entry as { conf?: unknown }).conf) });
    if (items.length >= topK) break;
  }
  return items.length > 0 ? items : DROP;
}

/** 单字段归一化；返回 DROP 表示丢弃该字段（不进结果） */
function normalizeValue(def: VisionFieldDef, value: unknown): unknown {
  switch (def.type) {
    case "string":
      return typeof value === "string" ? value : "";
    case "string[]":
      // 自定义 string[] 复用同一清洗管线（任务卡仅定义了这一条 string[] 规则）
      return cleanTags(value);
    case "enum": {
      // 裁定 B：带 topK 的自定义 enum 走 top-k 数组分支（同 enum_top2/3 逻辑）；
      // 无 topK 维持单值（值 ∈ options 才保留，否则丢弃；content_type 同理；
      // 无 options 的自定义 enum 保留任意字符串值）
      if (def.topK != null) {
        return normalizeTopK(value, def.topK, def.options ?? []);
      }
      if (typeof value !== "string") return DROP;
      if (def.options && def.options.length > 0 && !def.options.includes(value)) {
        return DROP;
      }
      return value;
    }
    case "enum_top3":
    case "enum_top2": {
      const topK = def.topK ?? (def.type === "enum_top3" ? 3 : 2);
      return normalizeTopK(value, topK, def.options ?? []);
    }
  }
}

/** 步骤 4：归一化（只认 fields 参数声明的 key，其余丢弃）；description/tags 单独入结果 */
function normalize(
  obj: Record<string, unknown>,
  fields: VisionFieldDef[],
): VisionParsed {
  const result: VisionParsed = { description: "", fields: {}, custom: {}, tags: [] };
  const declared = new Map(fields.map((f) => [f.key, f]));

  if (declared.has("description") && "description" in obj) {
    const v = obj.description;
    result.description = typeof v === "string" ? v : "";
  }
  if (declared.has("tags") && "tags" in obj) {
    result.tags = cleanTags(obj.tags);
  }

  for (const def of fields) {
    if (def.key === "description" || def.key === "tags") continue;
    if (!(def.key in obj)) continue; // 未产出键不进结果（analyze 合并时保留旧值）
    const normalized = normalizeValue(def, obj[def.key]);
    if (normalized === DROP) continue;
    if (BUILTIN_KEYS.has(def.key)) result.fields[def.key] = normalized;
    else result.custom[def.key] = normalized;
  }
  return result;
}

/** 容错解析入口：彻底失败抛 Error（带原始 text 前 200 字符） */
export function parseVisionResponse(
  text: string,
  fields: VisionFieldDef[],
): VisionParsed {
  try {
    const fixed = fixFullwidth(text);
    const candidate = extractCandidate(fixed);
    const obj = parseJson(candidate);
    return normalize(obj, fields);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message} | raw: ${text.slice(0, 200)}`);
  }
}
