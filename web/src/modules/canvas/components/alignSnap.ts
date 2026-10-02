/**
 * 对齐吸附引擎（任务 1.7）：纯函数，不依赖 React/Konva。
 * 输入移动盒（选中集合的联合包围盒）与目标盒列表（其余元素），
 * 每轴（水平/垂直）枚举 边线/中心线 3×3 组合，取 |差值| 最小且 ≤ 阈值的
 * 唯一候选（多目标时不来回跳），返回位移增量与参考线。
 * 坐标均为世界坐标；阈值由调用方按 5/zoom 折算，保证屏幕上恒定 5px 手感。
 */

/** 轴对齐包围盒（世界坐标；旋转元素取其视觉 AABB，与选中框一致） */
export interface SnapBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 对齐参考线（世界坐标）：v = 竖线（x = pos，y ∈ [from, to]）；h = 横线同理 */
export interface GuideLine {
  orientation: "v" | "h";
  pos: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: GuideLine[];
}

/** 单轴命中：移动盒某条线吸附到目标线（diff 为位移增量） */
interface AxisHit {
  diff: number;
  /** 目标线坐标（参考线位置） */
  line: number;
  /** 命中的目标盒（参考线端点范围用） */
  target: SnapBox;
}

/** 盒在水平方向的三条线：左边 / 中心 / 右边 */
function vLines(box: SnapBox): number[] {
  return [box.x, box.x + box.width / 2, box.x + box.width];
}

/** 盒在垂直方向的三条线：顶边 / 中心 / 底边 */
function hLines(box: SnapBox): number[] {
  return [box.y, box.y + box.height / 2, box.y + box.height];
}

/** 单轴最佳吸附：移动盒线与各目标盒线两两配对，取 |diff| ≤ threshold 的最小者 */
function bestAxisHit(
  movingLines: number[],
  targets: SnapBox[],
  linesOf: (box: SnapBox) => number[],
  threshold: number,
): AxisHit | null {
  let best: AxisHit | null = null;
  for (const target of targets) {
    for (const line of linesOf(target)) {
      for (const moving of movingLines) {
        const diff = line - moving;
        if (Math.abs(diff) > threshold) continue;
        if (!best || Math.abs(diff) < Math.abs(best.diff))
          best = { diff, line, target };
      }
    }
  }
  return best;
}

/**
 * 计算吸附：两轴独立，可同时吸附（十字参考线）。
 * 参考线端点取吸附后移动盒与命中目标盒在垂直方向上的并集范围（贯穿式）。
 */
export function computeSnap(
  moving: SnapBox,
  targets: SnapBox[],
  threshold: number,
): SnapResult {
  const v = bestAxisHit(vLines(moving), targets, vLines, threshold);
  const h = bestAxisHit(hLines(moving), targets, hLines, threshold);
  const dx = v?.diff ?? 0;
  const dy = h?.diff ?? 0;
  const guides: GuideLine[] = [];
  if (v) {
    guides.push({
      orientation: "v",
      pos: v.line,
      from: Math.min(moving.y + dy, v.target.y),
      to: Math.max(moving.y + dy + moving.height, v.target.y + v.target.height),
    });
  }
  if (h) {
    guides.push({
      orientation: "h",
      pos: h.line,
      from: Math.min(moving.x + dx, h.target.x),
      to: Math.max(moving.x + dx + moving.width, h.target.x + h.target.width),
    });
  }
  return { dx, dy, guides };
}

/**
 * 两份参考线列表是否等价：dragmove 逐帧 setState 前去抖，
 * 位置未变时复用旧引用，避免多余重渲染。
 */
export function sameGuides(
  a: GuideLine[] | null,
  b: GuideLine[] | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (g, i) =>
      g.orientation === b[i].orientation &&
      g.pos === b[i].pos &&
      g.from === b[i].from &&
      g.to === b[i].to,
  );
}
