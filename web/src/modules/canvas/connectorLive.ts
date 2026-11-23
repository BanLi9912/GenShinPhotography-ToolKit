/**
 * M1 连接线实时更新注册表（任务 1.9、1.9 交互迭代）：
 * 拖动/变换元素时，对受影响的连线直接在 Konva 节点上更新 points 与圆点位置
 * （命令式，不过 React、不 setState），保证 60fps 流畅跟随。
 * 注册表值改为 Konva.Group（ConnectorNode 以 Group 回调 ref 注册，身份稳定）。
 */
import type Konva from "konva";
import { connectorPoints, type Box, nodeWorldBox } from "./connectorGeometry";
import type { ConnectorElement } from "./store";

/* ---- 模块级 Group 注册表 ---- */

const groupMap = new Map<string, Konva.Group>();

/**
 * 注册/解除连线渲染 Group 引用（ConnectorNode 回调 ref）。
 * 签名 (node | null) => void，兼容 React 回调 ref。
 */
export function registerConnectorArrow(
  id: string,
  group: Konva.Group | null,
): void {
  if (group) groupMap.set(id, group);
  else groupMap.delete(id);
}

/**
 * 拖动/变换期间实时更新受影响连线的端点位置。
 * @param affectedIds 被移动/变换的元素 id 集合
 * @param connectors 当前所有连线元素
 * @param getBox (id) => Box | null
 * @param _stage Konva Stage（保留参数兼容，实际未用）
 */
export function updateConnectorsLive(
  affectedIds: ReadonlySet<string>,
  connectors: ConnectorElement[],
  getBox: (id: string) => Box | null,
  stage: Konva.Stage,
): void {
  const gap = 8 / stage.scaleX(); // 屏幕 8px 端点间距（世界坐标）
  for (const c of connectors) {
    if (!affectedIds.has(c.props.fromId) && !affectedIds.has(c.props.toId))
      continue;
    const group = groupMap.get(c.id);
    if (!group) continue;
    const fromBox = getBox(c.props.fromId);
    const toBox = getBox(c.props.toId);
    if (!fromBox || !toBox) continue;
    const pts = connectorPoints(fromBox, toBox, gap);
    // 更新主形状（Line/Arrow 均有 points 方法，findOne 返 Node 需投射）
    const shape = group.findOne(".conn-shape") as { points(n: number[]): void } | undefined;
    if (shape) shape.points(pts);
    // 更新两端圆点位置（arrow === "both" 时有）
    const dots = group.find(".conn-dot");
    if (dots.length >= 2) {
      dots[0].x(pts[0]);
      dots[0].y(pts[1]);
      dots[1].x(pts[6]);
      dots[1].y(pts[7]);
    }
  }
}

/** 快捷入口：内部调用 nodeWorldBox，外部只需传入 nodeRefs + stage */
export function updateConnectorsLiveQuick(
  affectedIds: ReadonlySet<string>,
  connectors: ConnectorElement[],
  nodeRefs: ReadonlyMap<string, Konva.Node>,
  stage: Konva.Stage,
): void {
  const getBox = (id: string): Box | null => {
    const node = nodeRefs.get(id);
    if (!node) return null;
    return nodeWorldBox(node, stage);
  };
  updateConnectorsLive(affectedIds, connectors, getBox, stage);
}
