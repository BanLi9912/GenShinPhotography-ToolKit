/**
 * 以图搜图（2026-09-24 任务卡）：剪贴板粘贴图 → 同口径特征提取 → 伪目标。
 * - 特征复用 pipeline/basicAnalysis.analyzeImage（64² 统计 + 32² pHash +
 *   palette 6 色）；粘贴图先缩到最长边 ≤960（对齐库内 thumbs 口径，
 *   特征才可比）
 * - 伪目标只携带色彩/轮廓/影调三路信号（tags 空、fields 空 → 其余信号
 *   在 findSimilar 的"两侧都有数据才计入"规则下天然缺席，不跑云端识图）
 * - 阈值随**搜索温度档位**走（2026-09-26 用户口径"阈值和温度控件绑定"）：
 *   t0–t5 → 0.75/0.70/0.65/0.55/0.50/0.45，默认档 t3 恰为卡定稿的 0.55，
 *   故不动滑块时行为与首版逐字节一致；精准档收严、联想档放宽。
 *   控件旁**不显示**阈值读数（同日用户口径"不要在温度控件边上标那个阈值"），
 *   档位与阈值的关系只体现在结果条数上
 * - 条数不再截断（同口径修订）：阈值内命中**全量**参与展示排序，首屏 24 张、
 *   底部「加载更多」每批 +24；跨库图片轨同样吃全量（分组内自带 12 张预览/展开）
 */
import { findSimilarWith } from "./similar";
import type { SearchHit } from "./rank";
import type { LibraryIndexItem } from "../index/indexFile";
import { analyzeImage, type AnalysisPatch } from "../pipeline/basicAnalysis";

/**
 * 相似度阈值兜底值（低于此值直接排除）：仅当温度越界取不到档位时用；
 * 默认档 t3 的档位阈值与之相同，故"默认 = 0.55"这一卡定稿口径不变。
 */
export const IMAGE_QUERY_FLOOR = 0.55;

/**
 * 温度档位 → 图片相似度阈值（t0 最严 → t5 最松，与文本轨温度方向一致）。
 * 索引即 `store.temperature`；t3 = 0.55 为卡定稿值（默认档）。
 */
const FLOOR_BY_TEMPERATURE = [0.75, 0.7, 0.65, 0.55, 0.5, 0.45];

/** 按温度档位取图片相似度阈值（越界钳到 0–5；缺省档 t3 = 0.55） */
export function imageQueryFloorOf(temperature: number): number {
  const idx = Math.min(
    FLOOR_BY_TEMPERATURE.length - 1,
    Math.max(0, Math.round(temperature)),
  );
  return FLOOR_BY_TEMPERATURE[idx];
}

/** 首屏张数 / 「加载更多」每批张数（2026-09-26 用户口径：首屏 24 + 每批 24） */
export const IMAGE_QUERY_BATCH = 24;

/** 空态文案（当前库与跨库分组共用，避免两处各写一遍漂移） */
export const IMAGE_QUERY_EMPTY_HINT = "没有相似的图片（相似度阈值内无命中）";

/**
 * 图片轨结果（当前库与跨库共用同一份口径）：伪目标在给定候选集上跑相似排序，
 * 返回 `SearchResult` 形状（items 分数降序 + hits 带理由），供网格/结果块直接吃。
 * **不截断**：阈值内全量返回，张数截断交给展示层（当前库 visibleCount 分批、
 * 跨库组内 12 张预览/展开）。调用方负责先做筛选（`searchItems(criteria.query="")`）。
 */
export function imageQueryHitsOf(
  candidates: LibraryIndexItem[],
  patch: AnalysisPatch,
  floor: number,
): { items: LibraryIndexItem[]; hits: Map<string, SearchHit> } {
  const results = findSimilarWith(
    pseudoImageQueryTarget(patch),
    candidates,
    floor,
    Number.POSITIVE_INFINITY,
  );
  return {
    items: results.map((r) => r.item),
    hits: new Map(
      results.map((r) => [
        r.item.id,
        { score: r.score, matchedTags: [] as string[], reasons: r.reasons },
      ]),
    ),
  };
}

/** 粘贴图缩放上限（与库内 thumbs 同口径：最长边 ≤960） */
const THUMB_MAX_SIDE = 960;


/** 提取粘贴图特征：缩到 ≤960 → analyzeImage；返回特征 + 展示用 objectURL */
export async function extractImageQueryFeatures(
  file: Blob,
): Promise<{ patch: AnalysisPatch; url: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  let small = bitmap;
  if (scale < 1) {
    small = await createImageBitmap(bitmap, {
      resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
      resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
      resizeQuality: "high",
    });
    bitmap.close();
  }
  try {
    const patch = analyzeImage(small);
    return { patch, url: URL.createObjectURL(file) };
  } finally {
    small.close();
  }
}

/**
 * 伪目标：粘贴图特征包装成 LibraryIndexItem 形状喂 findSimilar。
 * id 用不可能与真实条目撞的哨兵值（findSimilar 按 id 排除目标自身）。
 */
export function pseudoImageQueryTarget(patch: AnalysisPatch): LibraryIndexItem {
  return {
    id: "__image_query__",
    relPath: "",
    mtime: 0,
    size: 0,
    width: patch.width,
    height: patch.height,
    meanLuma: patch.meanLuma,
    meanSat: patch.meanSat,
    tone: patch.tone,
    hiColor: patch.hiColor,
    loColor: patch.loColor,
    phash: patch.phash,
    colors: patch.colors,
    description: "",
    fields: {},
    extra: {},
    tags: [],
    note: "",
    starred: false,
    analyzedAt: patch.analyzedAt,
    pipelineVersion: patch.pipelineVersion,
    thumb: null,
  };
}
