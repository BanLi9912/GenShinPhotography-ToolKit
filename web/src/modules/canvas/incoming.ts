/**
 * M1 图片接收入口（任务 M3.6）：图片导入管线提升 + 跨模块待收队列。
 * 原 `importImageFile` 定义在 CanvasPage 内部（只服务 OS 拖入/文件选择/粘贴），
 * M3「送去画布」需在画布组件之外落图，故提升到本文件：视口尺寸与容器尺寸
 * 改由参数传入，行为与提升前逐行一致（导入的三条既有入口改调本函数）。
 *
 * 待收队列：跨模块送图发生在画布未挂载时（按钮→跳转），而画布元素在
 * CanvasPage 挂载时才从 idb 水合（persistence.ts），跳转前直接 addElement
 * 会被水合覆盖——发送方只入队，画布挂载且水合完成后消费（见 CanvasPage）。
 */
import { fitToViewport, loadImageSize } from "./components/imageFiles";
import { putAssetBlob, registerAsset } from "./assets";
import { newElementId, useCanvasStore } from "./store";

/** 待收图片（M3.6 按钮送画布；模块级数组，消费即清空） */
let pendingImages: File[] = [];

/** 入队跨模块送来的图片（发送方在跳转前调用；顺序即落图级联顺序） */
export function queueImagesForCanvas(files: File[]): void {
  if (files.length === 0) return;
  pendingImages = [...pendingImages, ...files];
}

/** 取出并清空待收图片（画布挂载+水合完成后调用一次） */
export function consumePendingImages(): File[] {
  if (pendingImages.length === 0) return [];
  const files = pendingImages;
  pendingImages = [];
  return files;
}

/** 落图所需视口上下文：容器尺寸（fitToViewport 用）+ 当前缩放 */
export interface ImportContext {
  viewportW: number;
  viewportH: number;
  zoom: number;
}

/** 单张落图（视口尺寸由调用方给：容器未挂载时传 null，按 0 尺寸处理即原始大小） */
export function createImageAt(
  file: File,
  world: { x: number; y: number },
  container: HTMLDivElement | null,
): Promise<void> {
  const { viewport } = useCanvasStore.getState();
  return importImageFile(file, world, {
    viewportW: container?.clientWidth ?? 0,
    viewportH: container?.clientHeight ?? 0,
    zoom: viewport.zoom,
  });
}

/**
 * 图片导入：注册资产（objectURL 入缓存）→ blob 写 IndexedDB + 解码取原始尺寸
 * → 在 world 落点创建元素（中心对齐）。
 */
export async function importImageFile(
  file: File,
  world: { x: number; y: number },
  ctx: ImportContext,
): Promise<void> {
  const assetId = newElementId();
  // 先注册入缓存：保存 GC 把缓存视为"导入进行中"，不会误删这份资产
  const url = registerAsset(assetId, file);
  const [, natural] = await Promise.all([
    putAssetBlob(assetId, file),
    loadImageSize(url),
  ]);
  const { w, h } = fitToViewport(
    natural.width,
    natural.height,
    ctx.viewportW,
    ctx.viewportH,
    ctx.zoom,
  );
  useCanvasStore.getState().addElement({
    id: newElementId(),
    type: "image",
    transform: { x: world.x - w / 2, y: world.y - h / 2, w, h, rotation: 0 },
    props: { assetId },
  });
}
