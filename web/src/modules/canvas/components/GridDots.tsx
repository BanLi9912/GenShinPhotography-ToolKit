import { Shape } from "react-konva";
import type Konva from "konva";
import { useCssToken } from "./useCssToken";

/** 点阵基准间距（世界坐标 px）；缩得太小时自动翻倍，避免糊成一片 */
const BASE_GAP = 24;
/** 点在屏幕上的最小间距（px），低于此值即把世界间距翻倍 */
const MIN_SCREEN_GAP = 16;
/** 点半径（屏幕 px），不随缩放变化——网格是界面而非内容 */
const DOT_RADIUS = 1.5;

/**
 * 点阵网格背景：单 Shape + sceneFunc 一次性绘制，只画视口内的点。
 * 在世界坐标系绘制、半径按 1/zoom 折算——屏幕上永远一样大、一样疏密，
 * 且网格随 Stage 平移/缩放同步移动。颜色走 token --canvas-grid-dot 随主题切换。
 */
export function GridDots() {
  const dotColor = useCssToken("--canvas-grid-dot", "#d0d0d5");

  const sceneFunc = (context: Konva.Context, shape: Konva.Shape) => {
    const stage = shape.getStage();
    if (!stage) return;
    const zoom = stage.scaleX() || 1;

    // 视口对应的世界矩形
    const viewLeft = -stage.x() / zoom;
    const viewTop = -stage.y() / zoom;
    const viewRight = viewLeft + stage.width() / zoom;
    const viewBottom = viewTop + stage.height() / zoom;

    // 自适应间距：屏幕上太密就把世界间距翻倍
    let gap = BASE_GAP;
    while (gap * zoom < MIN_SCREEN_GAP) gap *= 2;

    const radius = DOT_RADIUS / zoom;
    context.beginPath();
    for (let x = Math.floor(viewLeft / gap) * gap; x <= viewRight; x += gap) {
      for (
        let y = Math.floor(viewTop / gap) * gap;
        y <= viewBottom;
        y += gap
      ) {
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, Math.PI * 2);
      }
    }
    context.fillShape(shape); // 以 Shape 的 fill（= token 颜色）填充整副路径
  };

  return (
    <Shape
      sceneFunc={sceneFunc}
      fill={dotColor}
      listening={false}
      perfectDrawEnabled={false}
    />
  );
}
