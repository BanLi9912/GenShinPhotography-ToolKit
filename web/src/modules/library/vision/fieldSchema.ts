/**
 * M3.5.1 云端识图 · 内置字段表（规划 §7.1 逐字为数据源）。
 * 表序即字段行序；constraint/example/counterExample 按 §7.1 列文本逐字抄入，
 * 禁止润色改写（含标点与全角符号）。
 */

export type VisionFieldType =
  | "string"
  | "string[]"
  | "enum"
  | "enum_top3"
  | "enum_top2";

export interface VisionFieldDef {
  key: string;
  type: VisionFieldType;
  /** §7.1「取值约束」列文本（提示词字段行素材） */
  constraint: string;
  /** §7.1「正例」列（注释/调试展示用） */
  example: string;
  /** §7.1「反例」列 */
  counterExample: string;
  /** content_type = false，其余 true */
  defaultEnabled: boolean;
  /** enum 词表（可被 fieldConfig.options 覆盖） */
  options?: string[];
  topK?: 2 | 3;
}

/** §7.1 表 11 行，顺序即表序 */
export const BUILTIN_FIELDS: VisionFieldDef[] = [
  {
    key: "description",
    type: "string",
    constraint:
      "中文 2–4 句，≤200 字；客观描述主体、场景、光线、色彩、氛围；供全文检索与选词转 tag",
    example:
      "\"二次元厚涂风格插画，蓝发少女半身像居于画面右三分线。她身着白色水手服，双手捧着冒热气的茶杯，背景是傍晚窗边的教室。侧逆光在发丝边缘勾出暖金色轮廓光，整体暖调低饱和，氛围安静治愈。\"",
    counterExample:
      "\"这是一张很美的截图\"（空泛）；\"作者想表达角色的孤独\"（编造意图）",
    defaultEnabled: true,
  },
  {
    key: "subject",
    type: "string",
    constraint: "一句话说清画面主体；无明确主体填 \"\"",
    example: "\"捧热茶的蓝发少女\"",
    counterExample: "\"画面很有故事感\"（非主体描述）",
    defaultEnabled: true,
  },
  {
    key: "scene",
    type: "string",
    constraint: "场景类型短词，≤10 字（原作场景名/现实场景名优先）",
    example: "\"傍晚教室\" / \"璃月港夜景\"",
    counterExample: "\"一个地方的风景\"（含糊）",
    defaultEnabled: true,
  },
  {
    key: "lighting",
    type: "string",
    constraint: "光线条件短语，≤15 字",
    example: "\"侧逆光+暖金轮廓光\" / \"技能蓝光自发光\"",
    counterExample: "\"光线很好\"（无信息）",
    defaultEnabled: true,
  },
  {
    key: "angle",
    type: "enum_top3",
    constraint:
      "拍摄视角，只从词表选择 1–3 项带置信度，按可能性降序；词表（存 fieldConfig.options，可编辑）：垂直=顶视/俯视/高角度/平视/低角度/仰视/贴地仰视，水平=正面/斜侧/侧面/背面，兜底=其他；conf∈[0,1]，conf<0.3 不进筛选",
    example:
      "[{\"term\":\"低角度仰视\",\"conf\":0.85},{\"term\":\"平视\",\"conf\":0.10},{\"term\":\"其他\",\"conf\":0.05}]",
    counterExample: "\"低角度仰拍，压迫感构图\"（混入构图/自造词，禁止）",
    defaultEnabled: true,
    options: [
      "顶视",
      "俯视",
      "高角度",
      "平视",
      "低角度",
      "仰视",
      "贴地仰视",
      "正面",
      "斜侧",
      "侧面",
      "背面",
      "其他",
    ],
    topK: 3,
  },
  {
    key: "composition",
    type: "enum_top2",
    constraint:
      "构图方式，只从词表选 1–2 项带置信度；词表（可编辑）：三分法/居中/对称/引导线/框架式/对角线/留白/其他；规则同 angle",
    example: "[{\"term\":\"三分法\",\"conf\":0.88},{\"term\":\"引导线\",\"conf\":0.10}]",
    counterExample: "\"构图很好\"（空泛，禁止）",
    defaultEnabled: true,
    options: ["三分法", "居中", "对称", "引导线", "框架式", "对角线", "留白", "其他"],
    topK: 2,
  },
  {
    key: "shot",
    type: "enum_top2",
    constraint:
      "景别，只从词表选 1–2 项带置信度；词表（可编辑）：特写/近景/中景/全景/远景/头像/胸像/半身像/七分身/全身像/其他；规则同 angle",
    example: "[{\"term\":\"中景\",\"conf\":0.85},{\"term\":\"全景\",\"conf\":0.12}]",
    counterExample: "\"距离适中\"（非词表词，禁止）",
    defaultEnabled: true,
    options: [
      "特写",
      "近景",
      "中景",
      "全景",
      "远景",
      "头像",
      "胸像",
      "半身像",
      "七分身",
      "全身像",
      "其他",
    ],
    topK: 2,
  },
  {
    key: "color_mood",
    type: "string",
    constraint: "色彩倾向短语，≤15 字",
    example: "\"冷调蓝紫，低饱和\"",
    counterExample: "\"颜色很丰富\"（空泛）",
    defaultEnabled: true,
  },
  {
    key: "mood_style",
    type: "string",
    constraint: "情绪与风格短语，≤15 字",
    example: "\"孤寂，电影感\"",
    counterExample: "\"感觉不错\"",
    defaultEnabled: true,
  },
  {
    key: "tags",
    type: "string[]",
    constraint:
      "5–10 个名词/短语；单个 ≤30 字符；去重；禁止 key:value 格式（角色名/画风/题材/服装优先）",
    example: "[\"二次元\",\"同人\",\"厚涂\",\"水手服\",\"少女\",\"教室\"]",
    counterExample:
      "[\"scene:璃月\"]（键值格式）；[\"刻晴\",\"刻晴\"]（重复）",
    defaultEnabled: true,
  },
  {
    key: "content_type",
    type: "enum",
    constraint: "photo | screenshot | fanart | artwork | render | texture | other",
    example: "\"photo\"",
    counterExample: "自由文本（必须枚举值）",
    defaultEnabled: false,
    options: [
      "photo",
      "screenshot",
      "fanart",
      "artwork",
      "render",
      "texture",
      "other",
    ],
  },
];

/** 用户自定义字段（产出写入记录 extra） */
export interface CustomFieldDef {
  key: string;
  label: string;
  type: "string" | "string[]" | "enum";
  hint: string;
  options?: string[];
}

/** 图库级字段配置：内置字段开关 + 词表覆盖 + 自定义字段（存 meta.json settings.fieldConfig） */
export interface FieldConfig {
  disabled?: string[];
  /** 裁定 C（5.1 回执 7）：显式启用通道（content_type 默认关，经此开启） */
  enabled?: string[];
  options?: Record<string, string[]>;
  custom?: CustomFieldDef[];
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;
}

/** 宽容解析 fieldConfig（未知形状按空处理，不抛错） */
function parseFieldConfig(raw: Record<string, unknown>): FieldConfig {
  const cfg: FieldConfig = {};
  const disabled = asStringArray(raw.disabled);
  if (disabled) cfg.disabled = disabled;
  const enabled = asStringArray(raw.enabled);
  if (enabled) cfg.enabled = enabled;
  if (raw.options && typeof raw.options === "object" && !Array.isArray(raw.options)) {
    const options: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(raw.options as Record<string, unknown>)) {
      const arr = asStringArray(v);
      if (arr && arr.length > 0) options[k] = arr;
    }
    cfg.options = options;
  }
  if (Array.isArray(raw.custom)) {
    const custom: CustomFieldDef[] = [];
    for (const c of raw.custom) {
      const entry = c as Partial<CustomFieldDef> | null;
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.key === "string" &&
        typeof entry.label === "string" &&
        (entry.type === "string" || entry.type === "string[]" || entry.type === "enum")
      ) {
        custom.push({
          key: entry.key,
          label: entry.label,
          type: entry.type,
          hint: typeof entry.hint === "string" ? entry.hint : "",
          options: asStringArray(entry.options),
        });
      }
    }
    cfg.custom = custom;
  }
  return cfg;
}

/**
 * 启用字段解析：内置按「(defaultEnabled || enabled 显式启用) 且未被禁用」过滤并
 * 应用 options 词表覆盖（裁定 C：enabled/disabled 同键时 disabled 优先）；
 * 尾部追加 custom（映射成 VisionFieldDef，constraint = hint，
 * custom enum 的 topK 取 options 存在时 2，否则无）。
 * fieldConfig 为空对象时 = 10 个内置字段（11 − content_type）；
 * {enabled:["content_type"]} → 11 个。
 */
export function resolveEnabledFields(
  fieldConfig: Record<string, unknown>,
): VisionFieldDef[] {
  const cfg = parseFieldConfig(fieldConfig);
  const disabled = cfg.disabled ?? [];
  const enabled = cfg.enabled ?? [];
  const builtins = BUILTIN_FIELDS.filter(
    (f) =>
      (f.defaultEnabled || enabled.includes(f.key)) && !disabled.includes(f.key),
  ).map((f) => ({
    ...f,
    options:
      cfg.options?.[f.key] && cfg.options[f.key].length > 0
        ? cfg.options[f.key]
        : f.options,
  }));
  const customs: VisionFieldDef[] = (cfg.custom ?? []).map((c) => ({
    key: c.key,
    type: c.type,
    constraint: c.hint,
    example: "",
    counterExample: "",
    defaultEnabled: true,
    options: c.options,
    topK: c.type === "enum" && c.options ? 2 : undefined,
  }));
  return [...builtins, ...customs];
}
