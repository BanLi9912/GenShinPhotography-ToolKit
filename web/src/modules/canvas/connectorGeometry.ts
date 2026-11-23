/**
 * M1 连接线几何（任务 1.9）：纯函数，无 React/Konva 依赖。
 * 提供盒边界锚点计算、贝塞尔控制点生成、曲线中点定位与节点世界包围盒换算。
 */
import type Konva from "konva";

/** 世界坐标包围盒（与 alignSnap.ts 的 SnapBox 等价，局部定义避免循环引用） */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 从盒中心向 toward 点引射线，求与盒边界的交点及该边的外法线。
 * 上下左右四边取 t > 0 最小者；退化（中心与 toward 重合/在盒内）→ 法线 (1, 0)。
 */
export function anchorOnBox(
  box: Box,
  toward: { x: number; y: number },
): { point: { x: number; y: number }; normal: { x: number; y: number } } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;

  // 退化（重合/在盒内）：无法决定方向，取右法线
  if (dx === 0 && dy === 0)
    return { point: { x: cx, y: cy }, normal: { x: 1, y: 0 } };

  // 四候选边：上/下/左/右，每条边给出 t 使 center + t*(dx,dy) 落在该边上
  const candidates: {
    t: number;
    point: { x: number; y: number };
    normal: { x: number; y: number };
  }[] = [];

  // 上边 (y = box.y)
  if (dy !== 0) {
    const t = ((box.y - cy) / dy);
    if (t > 0) {
      const ix = cx + t * dx;
      if (ix >= box.x && ix <= box.x + box.w)
        candidates.push({ t, point: { x: ix, y: box.y }, normal: { x: 0, y: -1 } });
    }
  }
  // 下边 (y = box.y + box.h)
  if (dy !== 0) {
    const t = ((box.y + box.h - cy) / dy);
    if (t > 0) {
      const ix = cx + t * dx;
      if (ix >= box.x && ix <= box.x + box.w)
        candidates.push({ t, point: { x: ix, y: box.y + box.h }, normal: { x: 0, y: 1 } });
    }
  }
  // 左边 (x = box.x)
  if (dx !== 0) {
    const t = ((box.x - cx) / dx);
    if (t > 0) {
      const iy = cy + t * dy;
      if (iy >= box.y && iy <= box.y + box.h)
        candidates.push({ t, point: { x: box.x, y: iy }, normal: { x: -1, y: 0 } });
    }
  }
  // 右边 (x = box.x + box.w)
  if (dx !== 0) {
    const t = ((box.x + box.w - cx) / dx);
    if (t > 0) {
      const iy = cy + t * dy;
      if (iy >= box.y && iy <= box.y + box.h)
        candidates.push({ t, point: { x: box.x + box.w, y: iy }, normal: { x: 1, y: 0 } });
    }
  }

  // 取 t 最小（距离中心最近的命中边）
  candidates.sort((a, b) => a.t - b.t);
  const hit = candidates[0];
  if (hit) return { point: hit.point, normal: hit.normal };

  // 浮点精度兜底：未命中任何边
  return { point: { x: cx, y: cy }, normal: { x: 1, y: 0 } };
}

/**
 * 计算三次贝塞尔连接线的 8 个点：P1, C1, C2, P2。
 * 控制点 = 锚点 + 各侧法线 × clamp(中心距 × 0.4, 40, 160)。
 * @param gap 端点沿法线外移量（世界坐标；调用方传 `8 / zoom` 实现屏幕 8px 端点间距）
 */
export function connectorPoints(from: Box, to: Box, gap = 0): number[] {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };

  const fromAnchor = anchorOnBox(from, toCenter);
  const toAnchor = anchorOnBox(to, fromCenter);

  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const offset = Math.max(40, Math.min(160, dist * 0.4));

  // 锚点沿法线外移 gap（端点与元素边缘的屏幕恒定间距）
  const p1 = {
    x: fromAnchor.point.x + fromAnchor.normal.x * gap,
    y: fromAnchor.point.y + fromAnchor.normal.y * gap,
  };
  const c1 = {
    x: p1.x + fromAnchor.normal.x * offset,
    y: p1.y + fromAnchor.normal.y * offset,
  };
  const p2 = {
    x: toAnchor.point.x + toAnchor.normal.x * gap,
    y: toAnchor.point.y + toAnchor.normal.y * gap,
  };
  const c2 = {
    x: p2.x + toAnchor.normal.x * offset,
    y: p2.y + toAnchor.normal.y * offset,
  };

  return [p1.x, p1.y, c1.x, c1.y, c2.x, c2.y, p2.x, p2.y];
}

/** 三次贝塞尔 t=0.5 处中点：(P1 + 3C1 + 3C2 + P2) / 8 */
export function bezierMidpoint(points: number[]): { x: number; y: number } {
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = points;
  return {
    x: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
    y: (y1 + 3 * c1y + 3 * c2y + y2) / 8,
  };
}

/**
 * 节点的世界坐标包围盒（逻辑同 CanvasPage.tsx 的 nodeWorldBox）。
 * getClientRect 为屏幕坐标且含旋转，按 Stage 变换折算为世界坐标。
 */
export function nodeWorldBox(
  node: Konva.Node,
  stage: Konva.Stage,
): Box | null {
  const zoom = stage.scaleX();
  const r = node.getClientRect();
  return {
    x: (r.x - stage.x()) / zoom,
    y: (r.y - stage.y()) / zoom,
    w: r.width / zoom,
    h: r.height / zoom,
  };
}
