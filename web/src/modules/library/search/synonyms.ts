/**
 * M3.4 同义词典（口径钉死，任务卡 2026-08-08-M3.4 §4.2）。
 * 词典为 .ts 数据模块（tsconfig 未开 resolveJsonModule，不改编译配置）：
 * 扩充 = 编辑下方 SYNONYMS 字面量；运行时编辑器不做（backlog）。
 */

export const SYNONYMS: Record<string, string[]> = {
  夜景: ["夜晚", "夜色", "夜拍"],
  夜晚: ["夜景"],
  人像: ["人物", "写真", "肖像"],
  街拍: ["扫街", "街头"],
  风光: ["风景", "景色"],
  霓虹: ["霓虹灯", "neon"],
  雨: ["雨天", "下雨", "雨滴"],
  海: ["海边", "海景", "大海"],
  山: ["山峰", "山峦", "高山"],
  星空: ["星星", "银河"],
  猫: ["猫咪", "小猫"],
  咖啡: ["咖啡店", "咖啡馆"],
  建筑: ["楼房", "楼宇"],
  城市: ["都市", "城里"],
  傍晚: ["黄昏", "暮色"],
  黄昏: ["夕阳"],
};

/** 1 跳展开：word 为 key 时其 values ∪ 所有「values 含 word」条目的（key ∪ values），去重、不含 word */
function expandOneHop(word: string): string[] {
  const out = new Set<string>();
  const own = SYNONYMS[word];
  if (own) for (const v of own) out.add(v);
  for (const [key, values] of Object.entries(SYNONYMS)) {
    if (values.includes(word)) {
      out.add(key);
      for (const v of values) out.add(v);
    }
  }
  out.delete(word);
  return [...out];
}

/**
 * 双向同义展开：1 跳见 expandOneHop；2 跳 = 对 1 跳结果每个词再展 1 跳的并集，
 * 剔除 1 跳已含词与原词。结果顺序不保证（调用方只用集合语义）。
 */
export function expandSynonyms(word: string, hops: 1 | 2): string[] {
  const one = expandOneHop(word);
  if (hops === 1) return one;
  const two = new Set<string>();
  for (const w of one) {
    for (const x of expandOneHop(w)) two.add(x);
  }
  for (const x of one) two.delete(x);
  two.delete(word);
  return [...two];
}
