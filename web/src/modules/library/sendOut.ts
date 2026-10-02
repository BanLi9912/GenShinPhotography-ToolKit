/**
 * M3 送出链路助手（任务 M3.6）：图库条目 → M4 送去分析 / M1 送去画布 / 拖拽 payload。
 * 纯逻辑、不持状态（navigate 由调用方（路由内组件）以参数传入），
 * 取 File 只经 `api.ts` 的 `getLibraryItemFile`，跨模块只调对方 api.ts（架构铁律 §3）。
 */
import { queueImagesForCanvas } from "../canvas/api";
import { openImageFile } from "../lab/api";
import { getLibraryItemFile, LIBRARY_DRAG_MIME } from "./api";
import { toast } from "../../ui/toast";

/** 送出入口的条目定位（库 id + 库内相对路径，足以回取 File） */
export interface SendOutRef {
  libraryId: string;
  relPath: string;
}

/** 路由跳转函数（react-router 的 navigate 子集；helper 不直接依赖 hook） */
type Navigate = (to: string) => void;

/**
 * 逐个取原图 File（顺序读取，保序）：读不到的条目跳过并 console.warn，
 * 不因单张失败中断整批（批量送画布时位置关系与选中顺序一致）。
 */
export async function filesForItems(items: SendOutRef[]): Promise<File[]> {
  const files: File[] = [];
  for (const item of items) {
    try {
      const file = await getLibraryItemFile(item.libraryId, item.relPath);
      if (file) files.push(file);
      else console.warn("[library] 送出：条目文件不存在", item.relPath);
    } catch (err) {
      console.warn("[library] 送出：条目读取失败", item.relPath, err);
    }
  }
  return files;
}

/**
 * 送去分析（M3→M4）：先 `openImageFile` 装图再跳转——lab store 是模块级单例，
 * 装图成功即各分析面板现场取数（装图即分析），失败则提示且不跳转。
 */
export async function sendItemsToLab(
  file: File | null,
  navigate: Navigate,
): Promise<void> {
  if (!file) {
    toast("图片读取失败，未送出");
    return;
  }
  const ok = await openImageFile(file);
  if (!ok) {
    toast("图片读取失败，未送出");
    return;
  }
  navigate("/lab");
}

/**
 * 送去画布（M3→M1）：图片入 M1 待收队列（画布水合完成后消费，避免被会话恢复覆盖）
 * 再跳转；本函数不校验数量上限（批量上限由调用方裁定并提示）。
 */
export function queueItemsToCanvas(files: File[], navigate: Navigate): void {
  if (files.length === 0) {
    toast("图片读取失败，未送出");
    return;
  }
  queueImagesForCanvas(files);
  navigate("/canvas");
}

/**
 * 拖拽 payload：只带条目标识（HTML5 DnD 的 `dataTransfer.files` 应用内拖拽必为空，
 * 故必须自定义 MIME 传标识，落地方经 `getLibraryItemFile` 回取 File）。
 */
export function buildDragPayload(items: SendOutRef[]): string {
  return JSON.stringify(
    items.map((i) => ({ libraryId: i.libraryId, relPath: i.relPath })),
  );
}

/** 解析拖拽 payload：结构非法/JSON 写坏一律返回 null（调用方按"无内容"处理） */
export function parseDragPayload(text: string): SendOutRef[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items: SendOutRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return null;
    const { libraryId, relPath } = entry as Record<string, unknown>;
    if (typeof libraryId !== "string" || typeof relPath !== "string") return null;
    items.push({ libraryId, relPath });
  }
  return items;
}

/**
 * 开始拖拽（网格缩略图与详情页大图共用，R4.2）：
 * 写自定义 MIME payload + `text/plain` 文件名兜底；`source` 为拖拽源缩略图时
 * 顺带设拖影（原图拖影过大，缩略图更贴近实际手感）。
 */
export function beginLibraryItemDrag(
  dataTransfer: DataTransfer,
  items: SendOutRef[],
  source?: { el: Element | null; fileName: string },
): void {
  if (items.length === 0) return;
  dataTransfer.setData(LIBRARY_DRAG_MIME, buildDragPayload(items));
  dataTransfer.setData(
    "text/plain",
    source?.fileName ?? items[0].relPath.split("/").pop() ?? "图片",
  );
  dataTransfer.effectAllowed = "copy";
  const img = source?.el?.querySelector("img") ?? source?.el;
  if (img instanceof HTMLImageElement && img.src) {
    try {
      dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
    } catch {
      /* 拖影设置失败不影响拖拽本体 */
    }
  }
}
