/**
 * M3.4.5 向量轨 · 文档构造与哈希（正式落地，原型 = .tools/shots/m34vector-poc.mjs buildDoc，
 * 逐字移植逻辑）。
 *
 * buildDoc(item)：把条目文本字段拼成一段向量化文档——
 * description → note → fields.subject/.scene/.lighting/.color_mood/.mood_style/.content_type
 * → angle/composition/shot 的 term（数组展平）→ tags[].text（空格连接整段收尾）。
 * 数值字段、relPath/文件名、extra 一律不进；空值/空数组/类型不符跳过不抛错；
 * 段间以换行连接；超 2000 字符截断。返回 "" = 无可嵌入文本（向量轨跳过该条目）。
 *
 * docHash(item) = fnv1a(buildDoc(item)) 8 位 hex——增量嵌入的脏位比对依据：
 * 任一文本字段变化 → 文档变 → hash 变 → 重嵌（无需在各写入点埋脏位）。
 */
import type { LibraryIndexItem } from "../../index/indexFile";
import { fnv1a } from "../../index/indexFile";

/** 文档总长上限（与 PoC 一致；再长截断，避免嵌入超大文本） */
const DOC_MAX_LEN = 2000;

/** string 型识图字段（字段顺序钉死，来源 fieldSchema BUILTIN_FIELDS 文本型） */
const TEXT_FIELD_KEYS = [
  "subject",
  "scene",
  "lighting",
  "color_mood",
  "mood_style",
  "content_type",
] as const;

/** term 数组型识图字段（[{term, conf}]，只取 term 文本） */
const TERM_ARRAY_KEYS = ["angle", "composition", "shot"] as const;

export function buildDoc(item: LibraryIndexItem): string {
  const seg: string[] = [];
  const pushStr = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) seg.push(v.trim());
  };
  pushStr(item.description);
  pushStr(item.note);
  const fields = item.fields && typeof item.fields === "object" ? item.fields : {};
  for (const k of TEXT_FIELD_KEYS) pushStr(fields[k]);
  for (const k of TERM_ARRAY_KEYS) {
    const arr = fields[k];
    if (Array.isArray(arr)) {
      const terms: string[] = [];
      for (const entry of arr) {
        if (entry && typeof entry === "object" && typeof entry.term === "string") {
          const t = entry.term.trim();
          if (t) terms.push(t);
        }
      }
      if (terms.length) seg.push(terms.join(" "));
    }
  }
  if (Array.isArray(item.tags)) {
    const texts: string[] = [];
    for (const tag of item.tags) {
      const text = typeof tag === "string" ? tag : tag && typeof tag.text === "string" ? tag.text : "";
      if (text.trim()) texts.push(text.trim());
    }
    if (texts.length) seg.push(texts.join(" "));
  }
  let doc = seg.join("\n").replace(/\n{2,}/g, "\n");
  if (doc.length > DOC_MAX_LEN) doc = doc.slice(0, DOC_MAX_LEN);
  return doc;
}

/** 条目文档哈希：文本变化即变化（增量嵌入脏位比对，R4 零侵入方案的核心） */
export function docHash(item: LibraryIndexItem): string {
  return fnv1a(buildDoc(item));
}
