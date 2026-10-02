/**
 * M3.4 输入补全与搜索历史（口径钉死，任务卡 2026-08-08-M3.4 §4.4）。
 * 历史走 localStorage（"ystk-lib-search-history"），与索引/磁盘无关。
 */
import type { LibraryIndexItem } from "../index/indexFile";

const HISTORY_KEY = "ystk-lib-search-history";
const HISTORY_LIMIT = 20;
const SUGGEST_LIMIT = 8;

/** 读取历史（MRU 序）；损坏/非数组返回空 */
export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** 写入历史：MRU 去重置顶，上限 20 条；空串不入 */
export function pushHistory(query: string): void {
  const trimmed = query.trim();
  if (!trimmed) return;
  const next = [trimmed, ...loadHistory().filter((h) => h !== trimmed)].slice(
    0,
    HISTORY_LIMIT,
  );
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式/配额满：静默失败，不影响检索
  }
}

/**
 * 补全建议：历史（MRU）+ 当前图库全部 tag 文本去重（按图数降序）。
 * input 非空：前缀命中排前、子串命中排后，合并去重截 8 条；空：只回历史前 8 条。
 */
export function getSuggestions(input: string, items: LibraryIndexItem[]): string[] {
  const history = loadHistory();
  const tagCounts = new Map<string, number>();
  for (const item of items) {
    for (const t of item.tags) {
      tagCounts.set(t.text, (tagCounts.get(t.text) ?? 0) + 1);
    }
  }
  const tagOrder = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([text]) => text);
  const corpus = [...history, ...tagOrder];
  const seen = new Set<string>();
  const out: string[] = [];
  const text = input.trim();
  if (!text) {
    for (const word of corpus) {
      if (out.length >= SUGGEST_LIMIT) break;
      if (!seen.has(word)) {
        seen.add(word);
        out.push(word);
      }
    }
    return out;
  }
  const prefix: string[] = [];
  const substring: string[] = [];
  for (const word of corpus) {
    if (seen.has(word)) continue;
    if (word.startsWith(text)) {
      seen.add(word);
      prefix.push(word);
    } else if (word.includes(text)) {
      seen.add(word);
      substring.push(word);
    }
  }
  return [...prefix, ...substring].slice(0, SUGGEST_LIMIT);
}
