import { useMemo } from "react";
import { Shape } from "react-konva";
import type Konva from "konva";
import { useCanvasStore, type TextElement } from "../store";
import { layoutTextBlock, runFont } from "./richText";
import { useCssToken } from "./useCssToken";

/** 文本行高：与编辑态 contentEditable 的 line-height 一致，保证进出编辑视觉连续 */
export const TEXT_LINE_HEIGHT = 1.4;

interface TextNodeProps {
  element: TextElement;
  /** 空格平移态：元素拖拽让位给画布平移（按住空格拖哪里都平移） */
  spaceHeld: boolean;
  /** 向 CanvasPage 注册 Konva 节点（Transformer 绑定用），卸载时传 null */
  registerNode: (id: string, node: Konva.Node | null) => void;
}

/**
 * 文本块节点（任务 1.2）：单击选中，选中后可拖动（防误拖），双击进入编辑。
 * Konva.Text 不支持局部样式，故用单 Shape + sceneFunc 按 run 自绘：
 * 排版经 layoutTextBlock 走 CSS 行盒模型（含 strut、行内共用基线，
 * textBaseline "alphabetic" 直接画在基线上），与编辑态 contentEditable
 * 渲染逐项对齐，进出编辑不错位。宽度随内容自适应（§2.1.2 M1-10）；
 * 命中区为整块矩形，编辑态下隐藏（由 contentEditable 覆盖层接管）。
 * 拖拽写回统一在 CanvasPage 的 Stage 事件处理（任务 1.4 多选整体移动）。
 */
export function TextNode({ element: el, spaceHeld, registerNode }: TextNodeProps) {
  const editingId = useCanvasStore((s) => s.editingId);
  const setSelectedIds = useCanvasStore((s) => s.setSelectedIds);
  const setEditingId = useCanvasStore((s) => s.setEditingId);
  const fontFamily = useCssToken("--font-ui", "system-ui, sans-serif");
  const themeColor = useCssToken("--text-1", "#1c1c20");
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(el.id));

  const blockColor = el.props.color ?? themeColor;

  const layout = useMemo(
    () =>
      layoutTextBlock(
        el.props.runs,
        el.props.fontSize,
        fontFamily,
        TEXT_LINE_HEIGHT,
      ),
    [el.props.runs, el.props.fontSize, fontFamily],
  );

  const sceneFunc = (context: Konva.Context) => {
    context.setAttr("textBaseline", "alphabetic");
    let lineY = 0;
    for (const line of layout.lines) {
      let x =
        el.props.align === "left"
          ? 0
          : el.props.align === "center"
            ? (layout.width - line.width) / 2
            : layout.width - line.width;
      for (const run of line.runs) {
        context.setAttr("font", runFont(run.bold, run.fontSize, fontFamily));
        context.setAttr("fillStyle", run.color ?? blockColor);
        context.fillText(run.text, x, lineY + line.baseline);
        x += run.width;
      }
      lineY += line.height;
    }
  };

  const hitFunc = (context: Konva.Context, shape: Konva.Shape) => {
    context.beginPath();
    context.rect(0, 0, shape.width(), shape.height());
    context.fillShape(shape);
  };

  return (
    <Shape
      ref={(node) => registerNode(el.id, node)}
      x={el.transform.x}
      y={el.transform.y}
      width={layout.width}
      height={layout.height}
      sceneFunc={sceneFunc}
      hitFunc={hitFunc}
      visible={editingId !== el.id}
      draggable={!spaceHeld && isSelected}
      onClick={(e) => {
        const s = useCanvasStore.getState();
        if (s.connectMode.active) {
          if (s.connectMode.sourceId === null) s.setConnectSource(el.id);
          else if (s.connectMode.sourceId === el.id) s.setConnectSource(null);
          else {
            s.addConnector(s.connectMode.sourceId, el.id, "end");
            s.setSelectedIds([]);            // 清空选中，避免 ConnectionToolbar 随每条新线闪现
            s.setConnectSource(el.id);       // 终点成为新起点，链式串联继续
          }
          return;
        }
        if (e.evt.ctrlKey || e.evt.metaKey) {
          s.ctrlToggleSelected(el.id);
          return;
        }
        setSelectedIds([el.id]);
      }}
      onTap={() => {
        const s = useCanvasStore.getState();
        if (s.connectMode.active) {
          if (s.connectMode.sourceId === null) s.setConnectSource(el.id);
          else if (s.connectMode.sourceId === el.id) s.setConnectSource(null);
          else {
            s.addConnector(s.connectMode.sourceId, el.id, "end");
            s.setSelectedIds([]);            // 清空选中，避免 ConnectionToolbar 随每条新线闪现
            s.setConnectSource(el.id);       // 终点成为新起点，链式串联继续
          }
          return;
        }
        setSelectedIds([el.id]);
      }}
      onDblClick={() => setEditingId(el.id)}
    />
  );
}
