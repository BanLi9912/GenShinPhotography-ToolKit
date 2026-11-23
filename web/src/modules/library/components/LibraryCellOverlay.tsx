/**
 * M3 图库格子公共覆盖层：主色板（按占比铺宽 + 命中图钉）/ 标签（命中高亮）/ 命中理由 / 星标。
 *
 * 抽出动机（PR-007 后续，用户口径"我要求所有图片的UI都一致"）：主网格 `OverviewGrid` 与
 * 跨图库结果块必须渲染**同一份**格子 UI，两处各写一套必然漂移（上一轮跨库块只搬了缩略图，
 * 色板与标签就丢了）。
 *
 * 交互差异刻意留在各自容器，不放进本组件：多选勾选框、缩略图拖拽送出、右键菜单都绑定
 * 当前库语境（送出入口按 `current.libraryId` 组 ref、选择集是当前库的），跨库格子不参与；
 * 色板点击（点色直达结果）由两侧共用同一个回调，行为一致。
 */
import { hexToRgb, labDistance, rgbToLab } from "../../../core/imaging/color";
import type { LibraryIndexItem } from "../index/indexFile";
import {
  colorThreshold,
  type ColorFilter,
  type SearchHit,
} from "../search/rank";

export function LibraryCellOverlay({
  item,
  hit,
  colorFilter,
  temperature,
  onSwatchPick,
}: {
  item: LibraryIndexItem;
  /** 命中信息（理由 + 命中 tag；无检索时为 undefined） */
  hit?: SearchHit;
  colorFilter?: ColorFilter | null;
  /** 搜索温度：命中图钉的 Lab 阈值随温度缩放（与筛选引擎一致） */
  temperature?: number;
  /** 色块点击：additive=true（Ctrl/⌘ 点击）加入取色行托盘；否则替换全部取色 */
  onSwatchPick?: (hex: string, additive: boolean) => void;
}) {
  /**
   * 取色筛选命中判定（三托盘）：色板色块距任一托盘颜色 Lab ≤ 温度阈值即命中；
   * 返回命中的托盘标签（tooltip 展示用）。组内逻辑不影响标注（标注只提示接近关系）。
   */
  const swatchHit = (hex: string): string[] => {
    if (!colorFilter) return [];
    const threshold = colorThreshold(temperature ?? 3);
    const near = (targetHex: string): boolean => {
      const target = hexToRgb(targetHex);
      if (!target) return false;
      const targetLab = rgbToLab(target.r, target.g, target.b);
      const rgb = hexToRgb(hex);
      return rgb
        ? labDistance(targetLab, rgbToLab(rgb.r, rgb.g, rgb.b)) <= threshold
        : false;
    };
    const anyNear = (colors: string[]) => colors.some(near);
    const zones: string[] = [];
    if (colorFilter.row.colors.length > 0 && anyNear(colorFilter.row.colors)) {
      zones.push("取色行");
    }
    if (colorFilter.hi.colors.length > 0 && anyNear(colorFilter.hi.colors)) {
      zones.push("高光");
    }
    if (colorFilter.lo.colors.length > 0 && anyNear(colorFilter.lo.colors)) {
      zones.push("阴影");
    }
    return zones;
  };

  return (
    <>
      <div className="lib-cell__overlay">
        <div className="lib-cell__swatches">
          {item.colors.map((c, i) => {
            const hitZones = swatchHit(c.hex);
            const isHit = hitZones.length > 0;
            const title = `${c.hex} · ${(c.ratio * 100).toFixed(1)}%${
              c.name ? ` · ${c.name}` : ""
            }${isHit ? ` · 命中（${hitZones.join("/")}）` : ""}${
              onSwatchPick ? " · 点击搜相似色 · Ctrl+点击加色" : ""
            }`;
            const style = {
              flexGrow: Math.max(0.01, c.ratio * 100),
              background: c.hex,
            };
            /* 命中标记：accent 实心圆点浮于命中色块正上方（图钉），描边见 CSS */
            const pin = isHit ? (
              <span className="lib-cell__swatch-hit" aria-hidden="true" />
            ) : null;
            return onSwatchPick ? (
              <button
                key={`${i}-${c.hex}`}
                type="button"
                className={"lib-cell__swatch" + (isHit ? " is-hit" : "")}
                style={style}
                title={title}
                aria-label={`搜索相似色 ${c.hex}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSwatchPick(c.hex, event.ctrlKey || event.metaKey);
                }}
              >
                {pin}
              </button>
            ) : (
              <span
                key={`${i}-${c.hex}`}
                className={"lib-cell__swatch" + (isHit ? " is-hit" : "")}
                style={style}
                title={title}
              >
                {pin}
              </span>
            );
          })}
        </div>
        {item.tags.length > 0 && (
          <span className="lib-cell__tags">
            {item.tags.slice(0, 3).map((t, i) => (
              <span
                key={`${i}-${t.text}`}
                className={
                  "lib-cell__tag" +
                  (hit?.matchedTags.includes(t.text) ? " is-hit" : "")
                }
              >
                {t.text}
              </span>
            ))}
          </span>
        )}
        {hit && hit.reasons.length > 0 && (
          <span className="lib-cell__reasons">
            {hit.reasons.slice(0, 2).join(" · ")}
          </span>
        )}
      </div>
      {item.starred && (
        <span className="lib-cell__star" aria-label="已标星">
          ★
        </span>
      )}
    </>
  );
}
