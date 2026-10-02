/**
 * M1 连接线渲染节点（任务 1.9 + 交互迭代）。
 * 用 Group 包裹，回调 ref 注册进 connectorLive（Group 身份跨模式稳定，注册表不 stale）；
 * "both" 模式：Line 作主形状 + 两端空心圆点（取代旧 Arrow+pointerAtBeginning）；
 * 选中态垫半透明加宽线；点击替换选中（connectMode 时忽略）；不注册 nodeRefs。
 */
import { Group, Line, Arrow, Circle } from "react-konva";
import type Konva from "konva";
import { useCanvasStore, type ConnectorElement } from "../store";
import { connectorPoints, type Box } from "../connectorGeometry";
import { registerConnectorArrow } from "../connectorLive";
import { useCssToken } from "./useCssToken";

interface ConnectorNodeProps {
  connector: ConnectorElement;
  zoom: number;
  /** CanvasPage 闭包：nodeRefs.get + nodeWorldBox → 世界盒 */
  getBox: (id: string) => Box | null;
}

export function ConnectorNode({ connector: c, zoom, getBox }: ConnectorNodeProps) {
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const setSelectedIds = useCanvasStore((s) => s.setSelectedIds);
  const connectMode = useCanvasStore((s) => s.connectMode);
  const accent = useCssToken("--accent", "#8c6d1f");
  const bgApp = useCssToken("--bg-app", "#f2f2f3");

  const isSelected = selectedIds.includes(c.id);
  const color = c.props.color ?? accent;

  const fromBox = getBox(c.props.fromId);
  const toBox = getBox(c.props.toId);
  if (!fromBox || !toBox) return null;

  const pts = connectorPoints(fromBox, toBox, 8 / zoom); // 屏幕 8px 端点间距（世界坐标）
  const isBoth = c.props.arrow === "both";
  const shapeCommon = {
    bezier: true as const,
    points: pts,
    stroke: color,
    strokeWidth: 2 / zoom,
    hitStrokeWidth: 12 / zoom,
    listening: true as const,
    onClick: () => {
      if (!connectMode.active) setSelectedIds([c.id]);
    },
    onTap: () => {
      if (!connectMode.active) setSelectedIds([c.id]);
    },
  };

  return (
    <Group ref={(g: Konva.Group | null) => registerConnectorArrow(c.id, g)}>
      {/* 选中垫片 */}
      {isSelected && (
        <Line
          {...shapeCommon}
          name="conn-ghost"
          listening={false}
          stroke={color}
          strokeWidth={(2 / zoom) + 4}
          opacity={0.35}
        />
      )}
      {/* 主形状 */}
      {isBoth ? (
        <Line {...shapeCommon} name="conn-shape" />
      ) : c.props.arrow === "none" ? (
        <Line {...shapeCommon} name="conn-shape" />
      ) : (
        <Arrow
          {...shapeCommon}
          name="conn-shape"
          fill={color}
          pointerLength={10 / zoom}
          pointerWidth={8 / zoom}
        />
      )}
      {/* 双端圆点 */}
      {isBoth && (
        <>
          <Circle
            name="conn-dot"
            x={pts[0]}
            y={pts[1]}
            radius={4.5 / zoom}
            stroke={color}
            strokeWidth={2 / zoom}
            fill={bgApp}
            listening={false}
          />
          <Circle
            name="conn-dot"
            x={pts[6]}
            y={pts[7]}
            radius={4.5 / zoom}
            stroke={color}
            strokeWidth={2 / zoom}
            fill={bgApp}
            listening={false}
          />
        </>
      )}
    </Group>
  );
}
