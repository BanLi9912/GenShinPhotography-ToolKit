/**
 * M3.5.1 云端识图 · 提示词拼装（规划 §7.2 模板逐字，禁止改写任何字）。
 * ONE_SHOT 固定内嵌，不随字段表裁剪——字段表裁剪时示例中多余字段由解析层
 * 容错忽略（见 parse.ts），无需联动改写。
 */

import type { VisionFieldDef, VisionFieldType } from "./fieldSchema";

/** §7.3 输出 JSON 示例逐字转成的对象字面量（11 个键全含，含 content_type） */
export const ONE_SHOT = {
  description:
    "二次元厚涂风格插画，蓝发少女半身像居于画面右三分线。她身着白色水手服，双手捧着冒热气的茶杯，背景是傍晚窗边的教室。侧逆光在发丝边缘勾出暖金色轮廓光，整体暖调低饱和，氛围安静治愈。",
  subject: "捧热茶的蓝发少女",
  scene: "傍晚教室",
  lighting: "侧逆光+暖金轮廓光",
  angle: [
    { term: "平视", conf: 0.9 },
    { term: "斜侧", conf: 0.07 },
    { term: "其他", conf: 0.03 },
  ],
  composition: [
    { term: "三分法", conf: 0.85 },
    { term: "留白", conf: 0.1 },
  ],
  shot: [
    { term: "半身像", conf: 0.88 },
    { term: "近景", conf: 0.08 },
  ],
  color_mood: "暖调低饱和，柔和",
  mood_style: "安静，治愈，日常感",
  tags: ["二次元", "同人", "厚涂", "水手服", "少女", "教室", "暖调"],
  content_type: "fanart",
};

/** §7.2 开头到「字段要求」引导行（逐字） */
export const TEMPLATE_HEAD = `你是一名摄影参考图库的资料编目员。用户会给你一张图片，你要提取结构化信息写入图库的检索索引。你的输出将直接驱动关键字搜索、标签筛选与相似图推荐——因此每个字段都必须具体、可检索、严格基于画面事实。

先按以下顺序完整观察图片，再逐字段作答，不要跳过任何一步：
1. 整体判断：图的类型与场景是什么？
2. 主体：画面最核心的人/物/元素是什么？处于什么状态、在做什么？
3. 环境：时间、地点、天气、背景中有哪些可辨识的元素？
4. 技术特征：光线的方向与质感、色彩倾向、拍摄视角、构图方式。
5. 氛围：画面客观呈现出的情绪与视觉风格。

字段要求（逐字段输出，不得遗漏、不得多输出字段）：`;

/** §7.2「内容质量要求」到末尾（逐字；{{ONE_SHOT_JSON}} 处替换为 §7.3 示例 JSON 全文） */
export const TEMPLATE_TAIL = `内容质量要求：
1. 具体名词优先：写"金毛犬"而非"动物"，写"悬铃木街道"而非"户外"。每个字段都要含有能被搜索命中的具体词汇。
2. 禁止空泛评价：不出现"美丽""好看""震撼""有艺术感"等无信息量词汇；不评判作品好坏。
3. 只写画面可见的事实，看不到的不要推测（无法判定时按格式规则第 4 条填空）。
4. description 必须覆盖：主体及其状态、场景、光线、色彩、氛围，让读者不看图也能想象画面，并能直接从中摘取检索关键词。
5. tags 从描述中提炼：优先具体名词（主体、场景、物件），其次光线/色彩/风格词；各 tag 互不重复、互不包含。

输出示例（仅示意格式与粒度，禁止照抄内容）：
${JSON.stringify(ONE_SHOT, null, 2)}

CRITICAL 输出格式规则（违反将导致解析失败，必须严格遵守）：
1. 只输出一个 JSON 对象本体：禁止 markdown 代码块标记、禁止任何解释性文字、禁止注释。
2. 标准 JSON 语法：字符串一律英文双引号、无尾随逗号、语法符号不用全角字符。
3. 所有文本值使用简体中文（专有名词除外）。
4. 无法客观判定的字段：字符串填 ""，数组填 []，枚举填 "other"；禁止编造。
5. 枚举类字段（angle/composition/shot 及自定义 enum）：只从该字段词表选择 1–3 项（按字段 top-k 配置），按可能性降序输出为 [{"term":"...","conf":0–1}]；词表内均不符时选"其他"；禁止自造词、禁止混入自由文本。angle 禁止推测拍摄者意图或情绪。
6. tags 输出 5–10 个，单个不超过 30 个字符，去重，不使用 "key:value" 格式。`;

const TYPE_DESC: Record<VisionFieldType, string> = {
  string: "字符串",
  "string[]": "字符串数组",
  enum: "枚举单值字符串",
  enum_top3: `枚举 top-3 数组（[{"term":"...","conf":0–1}]）`,
  enum_top2: `枚举 top-2 数组（[{"term":"...","conf":0–1}]）`,
};

/**
 * typeDesc（裁定 B）：enum 带 topK（自定义 enum 有词表）时输出 top-k 数组
 * 描述，与 parse 的 top-k 分支对齐；其余维持 TYPE_DESC 查表。
 */
function typeDescOf(def: VisionFieldDef): string {
  if (def.type === "enum" && def.topK != null) {
    return `枚举 top-${def.topK} 数组（[{"term":"...","conf":0–1}]）`;
  }
  return TYPE_DESC[def.type];
}

/** 字段行：- "{key}"：{typeDesc}。{constraint}{enumSuffix}；enumSuffix = 有 options 时（词表：a/b/c） */
function fieldLine(def: VisionFieldDef): string {
  const enumSuffix =
    def.options && def.options.length > 0
      ? `（词表：${def.options.join("/")}）`
      : "";
  return `- "${def.key}"：${typeDescOf(def)}。${def.constraint}${enumSuffix}`;
}

/** 头/尾覆盖（图库级 LibrarySettings.promptHead/promptTail）；trim 后为空的段回落默认 */
export interface PromptOverrides {
  head?: string;
  tail?: string;
}

/** 按启用字段拼装完整提示词（HEAD + 字段行 + TAIL）；头/尾可被图库级覆盖替换 */
export function buildPrompt(
  fields: VisionFieldDef[],
  overrides?: PromptOverrides,
): string {
  const head =
    overrides?.head != null && overrides.head.trim() !== ""
      ? overrides.head
      : TEMPLATE_HEAD;
  const tail =
    overrides?.tail != null && overrides.tail.trim() !== ""
      ? overrides.tail
      : TEMPLATE_TAIL;
  const lines = fields.map(fieldLine);
  return `${head}\n${lines.join("\n")}\n\n${tail}`;
}
