/**
 * M1 画布工程文件导出/导入（2026-09-26 任务卡）：
 * - 导出：单 JSON（元素 + 视口 + 图片资产 base64 内嵌），扩展名 .ystkboard；
 * - 导入：校验 → 确认替换 → 资产重新登记（新 assetId，防与现有库撞 id 覆盖）
 *   → 元素引用映射 → hydrate 整体替换（同会话恢复语义，清历史栈）；
 * - 防御：restoreBoard 同款（丢弃资产缺失图片元素 + 悬空连线）；
 * - UI 反馈对齐 exportPng（alert 兜底）；替换确认走 ui/confirm。
 */
import { confirmDialog } from "../../ui/confirm";
import { getAssetBlob, putAssetBlob, registerAsset } from "./assets";
import {
  newElementId,
  useCanvasStore,
  type CanvasElement,
  type ImageElement,
  type Viewport,
} from "./store";

/** 工程文件格式（BoardDoc 的资产内嵌版） */
interface BoardFile {
  format: "ystk-board";
  version: 1;
  exportedAt: string;
  viewport: Viewport;
  elements: CanvasElement[];
  assets: Array<{ id: string; type: string; dataUrl: string }>;
}

/** 文件名时间戳段（口径同 exportPng.exportFileName） */
function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${date}-${time}`;
}

/** Blob → base64 dataURL（不压缩不重编码，原样搬运） */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
    reader.readAsDataURL(blob);
  });
}

/** dataURL → Blob（fetch 协议处理器解析，原样搬运） */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return await res.blob();
}

/** 导出工程文件并触发下载。返回是否真的产出并下载了文件（调用方据此给轻提示） */
export async function exportBoardFile(): Promise<boolean> {
  try {
    const { elements, viewport } = useCanvasStore.getState();
    if (elements.length === 0) {
      alert("画布为空，没有可导出的内容");
      return false;
    }
    // 收集图片资产并内嵌 base64
    const assetIds = [
      ...new Set(
        elements
          .filter((e): e is ImageElement => e.type === "image")
          .map((e) => e.props.assetId),
      ),
    ];
    const assets: BoardFile["assets"] = [];
    for (const id of assetIds) {
      const blob = await getAssetBlob(id);
      if (!blob) {
        alert(`图片资产缺失（${id}），无法导出工程文件`);
        return false;
      }
      assets.push({ id, type: blob.type, dataUrl: await blobToDataUrl(blob) });
    }
    const doc: BoardFile = {
      format: "ystk-board",
      version: 1,
      exportedAt: new Date().toISOString(),
      viewport,
      elements,
      assets,
    };
    const blob = new Blob([JSON.stringify(doc)], { type: "application/json" });
    const objectURL = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectURL;
    a.download = `未命名画布-${stamp()}.ystkboard`;
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

/** 导入工程文件：校验 → 确认替换 → 资产重登记 → hydrate。返回是否成功 */
export async function importBoardFile(file: File): Promise<boolean> {
  let doc: BoardFile;
  try {
    doc = JSON.parse(await file.text()) as BoardFile;
  } catch {
    alert("不是有效的工程文件（JSON 解析失败）");
    return false;
  }
  if (
    doc?.format !== "ystk-board" ||
    doc.version !== 1 ||
    !Array.isArray(doc.elements) ||
    !Array.isArray(doc.assets) ||
    !doc.viewport ||
    typeof doc.viewport.zoom !== "number"
  ) {
    alert("不是有效的工程文件（格式或版本不符）");
    return false;
  }

  // 替换确认（当前画布非空时）
  const current = useCanvasStore.getState().elements;
  if (current.length > 0) {
    const ok = await confirmDialog({
      title: "导入工程文件",
      message: `导入将替换当前画布的 ${current.length} 个元素（自动保存会随后覆盖现有画布），确定继续？`,
      confirmText: "替换当前画布",
    });
    if (!ok) return false;
  }

  // 资产重登记：新 assetId（防与现有资产撞 id 覆盖），先缓存后落库（incoming 同序）
  const idMap = new Map<string, string>();
  const store = useCanvasStore.getState();
  for (const asset of doc.assets) {
    if (typeof asset.id !== "string" || typeof asset.dataUrl !== "string") continue;
    const newId = newElementId();
    try {
      const blob = await dataUrlToBlob(asset.dataUrl);
      registerAsset(newId, blob);
      await putAssetBlob(newId, blob);
      idMap.set(asset.id, newId);
    } catch {
      console.warn("[canvas] 工程资产导入失败，跳过", asset.id);
    }
  }

  // 元素防御（restoreBoard 同款）+ 引用映射
  const mapped = doc.elements
    .filter((e) => e && typeof e.id === "string" && e.type != null)
    .filter((e) => e.type !== "image" || idMap.has(e.props.assetId));
  const validIds = new Set(mapped.map((e) => e.id));
  const elements = mapped
    .filter((e) => {
      if (e.type !== "connector") return true;
      return validIds.has(e.props.fromId) && validIds.has(e.props.toId);
    })
    .map((e) =>
      e.type === "image"
        ? { ...e, props: { ...e.props, assetId: idMap.get(e.props.assetId)! } }
        : e,
    ) as CanvasElement[];

  if (elements.length === 0) {
    alert("工程文件内没有可恢复的元素（图片资产可能全部导入失败）");
    return false;
  }

  store.hydrate(elements, doc.viewport);
  return true;
}
