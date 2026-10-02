/**
 * 图片导入管线（任务 1.3）：解码取尺寸与初始显示尺寸计算。
 * 窗口拖入与 Ctrl+V 粘贴共用；二进制本体由 assets.ts 存 IndexedDB（任务 1.5）。
 */

/** 解码图片取原始尺寸 */
export function loadImageSize(
  src: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = src;
  });
}

/**
 * 初始显示尺寸：默认原始大小（不变形）；
 * 超出视口 80% 时等比缩小到视口内（大图拖入不至于铺满找不到边）。
 */
export function fitToViewport(
  naturalWidth: number,
  naturalHeight: number,
  viewWidth: number,
  viewHeight: number,
  zoom: number,
): { w: number; h: number } {
  const maxW = (viewWidth * 0.8) / zoom;
  const maxH = (viewHeight * 0.8) / zoom;
  const scale = Math.min(1, maxW / naturalWidth, maxH / naturalHeight);
  return { w: naturalWidth * scale, h: naturalHeight * scale };
}
