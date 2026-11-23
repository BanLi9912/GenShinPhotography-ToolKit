import { useEffect, useState } from "react";
import { Image as KonvaImage } from "react-konva";
import type Konva from "konva";
import { useCanvasStore, type ImageElement } from "../store";
import { getAssetUrl } from "../assets";

/** 变换手柄允许的最小尺寸（世界 px），防止误操作缩没 */
const MIN_SIZE = 8;

/** 载入图片（objectURL，来自 assets.ts 缓存）为 HTMLImageElement（Konva Image 的 image 源） */
function useHtmlImage(src: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) return; // 资产缺失：不渲染（恢复时已过滤，这里仅兜底）
    const el = new window.Image();
    el.onload = () => setImg(el);
    el.src = src;
    return () => {
      el.onload = null;
    };
  }, [src]);

  return img;
}

interface ImageNodeProps {
  element: ImageElement;
  /** 空格平移态：元素拖拽让位给画布平移 */
  spaceHeld: boolean;
  /** 向 CanvasPage 注册 Konva 节点（Transformer 绑定用），卸载时传 null */
  registerNode: (id: string, node: Konva.Node | null) => void;
  /** Transformer 逐帧回调（任务 1.9：连线实时跟随），可选 */
  onTransform?: () => void;
}

/**
 * 图片节点（任务 1.3）：单击选中，选中后才可拖动（防误拖）。
 * Transformer 手柄在 CanvasPage 统一绑定；变换结束时把 scale 折算回
 * width/height（Konva 标准写法），与坐标/旋转一起写回 store。
 * 拖拽写回统一在 CanvasPage 的 Stage 事件处理（任务 1.4 多选整体移动）。
 */
export function ImageNode({ element: el, spaceHeld, registerNode, onTransform }: ImageNodeProps) {
  const img = useHtmlImage(getAssetUrl(el.props.assetId));
  const setSelectedIds = useCanvasStore((s) => s.setSelectedIds);
  const setElementsTransforms = useCanvasStore((s) => s.setElementsTransforms);
  const isSelected = useCanvasStore((s) => s.selectedIds.includes(el.id));

  return (
    <KonvaImage
      ref={(node) => registerNode(el.id, node)}
      image={img ?? undefined}
      x={el.transform.x}
      y={el.transform.y}
      width={el.transform.w}
      height={el.transform.h}
      rotation={el.transform.rotation}
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
      onTransform={() => onTransform?.()}
      onTransformEnd={(e) => {
        const node = e.target;
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        node.scale({ x: 1, y: 1 });
        setElementsTransforms([
          {
            id: el.id,
            transform: {
              x: node.x(),
              y: node.y(),
              w: Math.max(MIN_SIZE, node.width() * scaleX),
              h: Math.max(MIN_SIZE, node.height() * scaleY),
              rotation: node.rotation(),
            },
          },
        ]);
      }}
    />
  );
}
