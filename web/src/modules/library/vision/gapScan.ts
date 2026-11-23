/**
 * M3.5.3.5 识图小窗「扫描全库缺口」· 纯函数扫描逻辑（任务卡 R1）。
 *
 * 判定口径（逐字按卡 R1.2）：
 * - 用 resolveEnabledFields(fieldConfig) 取本库启用字段（内置按 defaultEnabled/enabled/disabled，
 *   custom 追加——与识图 prompt 同源，保证「扫出的缺口 = 本轮识图会补的字段」）；
 * - 条目满足任一即为缺口：
 *   ① (visionVersion ?? 0) < 1（未跑或失败 -1）→ neverRun:true，missing=["未识图"]（不再逐字段扫，
 *     未跑条目的缺字段就是没跑本身，避免重复噪音）；
 *   ② 逐启用字段做「存在性 + 空值」检查，缺一记一（label 列表）：
 *     - description → !item.description?.trim()
 *     - tags → 无 source==="auto" 的 tag（手动 tag 不算识图产出）
 *     - string 型（subject/scene/lighting/color_mood/mood_style/content_type）→
 *       !(key in fields) 或值 trim 空（写回是浅合并 + parse DROP，禁用后启用的老条目可能没这个 key——
 *       必须用存在性检查，不是值判空）
 *     - 数组型（angle/composition/shot，[{term,conf}]）→ !(key in fields) / 非数组 / 空数组
 *     - 自定义字段（fieldConfig.custom）→ item.extra[key] 缺失 / 空串 / 空数组
 * 纯函数、零副作用、不 import store/React；类型从 indexFile/fieldSchema import。
 */
import type { LibraryIndexItem } from "../index/indexFile";
import {
  BUILTIN_FIELDS,
  resolveEnabledFields,
  type FieldConfig,
} from "./fieldSchema";

/** 缺口条目（missing = 缺失字段 label 列表；neverRun 时 = ["未识图"]） */
export interface GapItem {
  id: string;
  relPath: string;
  neverRun: boolean;
  missing: string[];
}

export interface GapScanResult {
  gaps: GapItem[];
  /** 未识图（visionVersion<1，含 -1 失败）条数 */
  neverRunCount: number;
  /** 跑过但字段不全条数 */
  fieldGapCount: number;
}

/** 内置字段中文名（与 SettingsPanel/DetailView FIELD_LABELS 同表，卡 §3 引用 label 做展示） */
const BUILTIN_LABELS: Record<string, string> = {
  description: "描述",
  subject: "主体",
  scene: "场景",
  lighting: "光线",
  angle: "视角",
  composition: "构图",
  shot: "景别",
  color_mood: "色彩倾向",
  mood_style: "情绪风格",
  tags: "标签",
  content_type: "内容类型",
};

/** string 型内置字段（fields[key] 为 string；content_type 亦单枚举 string） */
const STRING_BUILTIN = new Set([
  "subject",
  "scene",
  "lighting",
  "color_mood",
  "mood_style",
  "content_type",
]);
/** term 数组型内置字段（fields[key] = [{term,conf}]） */
const ARRAY_BUILTIN = new Set(["angle", "composition", "shot"]);
/** 内置字段全集（识别 custom 用） */
const BUILTIN_KEYS = new Set(BUILTIN_FIELDS.map((f) => f.key));

/** 单字段空判：raw 不存在 / 空串 / 空数组 → true（缺口） */
function isEmptyValue(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

export function scanLibraryGaps(
  items: LibraryIndexItem[],
  fieldConfig: FieldConfig,
): GapScanResult {
  const fields = resolveEnabledFields(fieldConfig as unknown as Record<string, unknown>);
  const customArr = Array.isArray(fieldConfig.custom) ? fieldConfig.custom : [];
  const customDefs = new Map(
    customArr
      .filter((c) => c && typeof c.key === "string" && typeof c.label === "string")
      .map((c) => [c.key, c.label]),
  );
  /** 启用字段 → 展示 label（内置查表；custom 用 def.label；兜底 key） */
  const labelOf = (key: string): string =>
    BUILTIN_LABELS[key] ?? customDefs.get(key) ?? key;

  const gaps: GapItem[] = [];
  let neverRunCount = 0;
  let fieldGapCount = 0;

  for (const item of items) {
    // ① 未识图（0/undefined/-1）
    if ((item.visionVersion ?? 0) < 1) {
      gaps.push({ id: item.id, relPath: item.relPath, neverRun: true, missing: ["未识图"] });
      neverRunCount += 1;
      continue;
    }
    // ② 已跑过 → 逐启用字段存在性 + 空值检查
    const missing: string[] = [];
    const fieldsObj = item.fields && typeof item.fields === "object" ? item.fields : {};
    for (const def of fields) {
      const key = def.key;
      if (key === "description") {
        if (!item.description?.trim()) missing.push(labelOf(key));
        continue;
      }
      if (key === "tags") {
        const hasAuto = Array.isArray(item.tags) && item.tags.some((t) => t.source === "auto");
        if (!hasAuto) missing.push(labelOf(key));
        continue;
      }
      if (STRING_BUILTIN.has(key)) {
        // 存在性检查优先（浅合并 + parse DROP 的写回，老条目可能整个 key 缺失）
        if (!(key in fieldsObj) || isEmptyValue(fieldsObj[key])) {
          missing.push(labelOf(key));
        }
        continue;
      }
      if (ARRAY_BUILTIN.has(key)) {
        const v = fieldsObj[key];
        if (!(key in fieldsObj) || !Array.isArray(v) || v.length === 0) {
          missing.push(labelOf(key));
        }
        continue;
      }
      // 自定义字段（不在内置集合）→ item.extra
      if (!BUILTIN_KEYS.has(key)) {
        if (isEmptyValue(item.extra?.[key])) missing.push(labelOf(key));
      }
    }
    if (missing.length > 0) {
      gaps.push({ id: item.id, relPath: item.relPath, neverRun: false, missing });
      fieldGapCount += 1;
    }
  }

  return { gaps, neverRunCount, fieldGapCount };
}
