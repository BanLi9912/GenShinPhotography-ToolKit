/**
 * M3 瀑布流布局口径（单一真相）：主网格 `OverviewGrid` 与跨图库结果块共用。
 * 抽出动机（PR-007 用户口径"图片显示方式沿用瀑布流"）：跨库结果的列数断点、格子间距、
 * 未分析条目占位比例必须与主网格**逐档一致**，分写两处必然漂移；
 * 且组件文件不允许导出非组件符号（oxlint `react(only-export-components)`）。
 */

/** 瀑布流列数：宽屏 4 / 中屏 3 / 窄屏 2（断点与设计一致） */
export function computeColumnCount(): number {
  if (typeof window === "undefined") return 4;
  const width = window.innerWidth;
  if (width <= 760) return 2;
  if (width <= 1100) return 3;
  return 4;
}

/** 格子间距（px）= `--space-2` */
export const GRID_GAP = 8;

/** 未分析条目（无宽高）的占位宽高比 */
export const GRID_EST_ASPECT = 4 / 3;
