/**
 * M1 画板导出 PNG（任务 1.8）
 *
 * 把画布全部内容的包围区域导出为 PNG（恒按 2 倍世界尺寸超采样，与视口缩放无关），
 * 带当前主题背景色，
 * 触发浏览器下载；导出前等待所有图片加载完成，画面中不含选择框/对齐线/
 * 点阵网格等辅助元素。
 */
import type Konva from "konva";
import { getAssetUrl } from "./assets";
import { useCanvasStore } from "./store";

/* ---- 内容 Layer 引用（由 CanvasPage 注册） ---- */

let contentLayer: Konva.Layer | null = null;

/** 注册 / 解除内容 Layer 引用（CanvasPage 挂载/卸载时调用） */
export function registerContentLayer(layer: Konva.Layer | null): void {
  contentLayer = layer;
}

/* ---- 内部工具 ---- */

/** 读取 CSS 变量当前计算值（逻辑同 useCssToken.ts 的 readToken） */
function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** 生成导出文件名。BoardDoc.meta.name 当前固定为 "未命名画布"（persistence.ts:82），
 *  将来接画板命名后再从 name 动态取。 */
function exportFileName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `未命名画布-${date}-${time}.png`;
}

/** 等待单张图片加载完成，包 5 秒超时 */
function waitForImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timeout = setTimeout(() => {
      img.src = "";
      reject(new Error("图片加载超时"));
    }, 5000);
    img.onload = () => {
      clearTimeout(timeout);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("图片加载失败"));
    };
    img.src = url;
  });
}

/* ---- 导出主流程 ---- */

/**
 * 将画布全部内容导出为 PNG 并触发浏览器下载。返回是否真的产出并下载了文件
 * （调用方——工具栏菜单——据此给"已导出"轻提示；失败路径仍由内部 alert 兜底）。
 *
 * 流程：
 * 1. 空画布早期返回；
 * 2. 退出编辑态 + 清空选中，双 rAF 等 React commit；
 * 3. 等待所有图片元素加载完成（各 5s 超时）；
 * 4. contentLayer.getClientRect() 取包围盒（含旋转、跳过不可见节点），四周 24px padding（世界坐标）；
 * 5. layer.toDataURL({ pixelRatio: 2 / zoom }) 得透明底 PNG（导出尺寸与视口缩放无关）；
 * 6. 读 --bg-app 合成背景色 → canvas.toBlob → <a download> 触发下载；
 * 7. try/catch 兜底 alert。
 */
export async function exportBoardPng(): Promise<boolean> {
  try {
    const { elements, setEditingId, setSelectedIds } =
      useCanvasStore.getState();

    // 1. 空画布
    if (elements.length === 0) {
      alert("画布为空，没有可导出的内容");
      return false;
    }

    // 2. 退出编辑态、清空选中（不产生撤销历史污染）
    setEditingId(null);
    setSelectedIds([]);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    // 3. 等待所有图片加载完成
    for (const el of elements) {
      if (el.type !== "image") continue;
      const url = getAssetUrl(el.props.assetId);
      if (!url) {
        alert("图片尚未加载完成，请稍后再试");
        return false;
      }
      try {
        await waitForImage(url);
      } catch {
        alert("图片尚未加载完成，请稍后再试");
        return false;
      }
    }

    if (!contentLayer) {
      alert("画布未就绪，请稍后再试");
      return false;
    }

    // 视口缩放（Stage scale；导出强制 100%：pixelRatio 按 zoom 补偿，
    // 导出像素恒 = 世界尺寸 × 2，与视口缩放无关——zoom=1 时与原行为一致）
    const zoom = contentLayer.getStage()?.scaleX() ?? 1;

    // 4. 包围盒 + 24px padding（世界坐标）。getClientRect 是**屏幕坐标系**（已含 zoom，
    //    见 CanvasPage 世界坐标折算处），故包围盒与 padding 一并按 zoom 折算，
    //    导出尺寸才只由内容世界尺寸决定。
    const rect = contentLayer.getClientRect();
    const PAD = 24;
    const x = rect.x - PAD * zoom;
    const y = rect.y - PAD * zoom;
    const width = rect.width + PAD * 2 * zoom;
    const height = rect.height + PAD * 2 * zoom;

    // 5. 透明底 PNG（pixelRatio 2/zoom：恒按 2 倍世界尺寸超采样，与视口缩放无关；
    //    天然不含 GridDots 层）
    const dataURL = contentLayer.toDataURL({
      x,
      y,
      width,
      height,
      pixelRatio: 2 / zoom,
      mimeType: "image/png",
    });

    // 6. 合成背景色
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("导出图像加载失败"));
      image.src = dataURL;
    });

    const bgColor = readToken("--bg-app", "#f2f2f3");
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    // 7. blob → download
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });
    if (!blob) {
      alert("导出失败：无法生成图片数据");
      return false;
    }
    const objectURL = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectURL;
    a.download = exportFileName();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectURL);
    return true;
  } catch (err) {
    alert("导出失败：" + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}
