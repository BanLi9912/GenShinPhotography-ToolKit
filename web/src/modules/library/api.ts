/**
 * M3 参考图库 · 对外接口
 * 模块约定（§3.3）：对外只暴露本文件；状态在 store.ts；组件在 components/；
 * 索引/绑定/扫描在 index/。应用壳经本文件取页面组件与 store（开发者日志订阅，2026-09-24）。
 * 图像来源协作（M3.6 定案 D7）走 api 直调，不建 core/events 事件总线：
 * M3 调 `lab/api.openImageFile` 送分析；M1 经 `canvas/api.queueImagesForCanvas`
 * 收图；拖拽经 `LIBRARY_DRAG_MIME` 传标识 + `getLibraryItemFile` 回取 File。
 */
import { readFileBlob } from "../../core/storage/fsa";
import { getEntry } from "./index/binding";

export { LibraryPage } from "./components/LibraryPage";
export { LibraryGlobalSettingsPanel } from "./components/GlobalSettingsPanel";
export { LibraryRegistryPanel } from "./components/LibraryRegistryPanel";
export { useLibraryStore } from "./store";
export type { LibraryScanResult } from "./store";
export { ensureEntryPermission, getEntry, listSummaries } from "./index/binding";
export type { LibraryRegistryEntry } from "./index/binding";
/**
 * 浏览器拖拽采集桥（2026-11-12 任务卡）：应用壳在 App 的 effect 里挂载/清理，
 * 采集只落盘不触发扫描——接收端实现全部在 `collector/`，不从这里再导出内部。
 */
export { startCollectorBridge } from "./collector/bridge";

/** 应用内拖拽的自定义类型（M3.6）：payload 只带条目标识，落地方经本文件回取 File */
export const LIBRARY_DRAG_MIME = "application/x-ystk-library-items";

/**
 * 取图库条目原图 File（M3.6 送出链路共用）：
 * getEntry 查目录句柄 → readFileBlob 读条目 relPath；库未注册/路径不存在返回 null
 * （读取异常上抛由调用方兜底，口径同 DetailView 的图片加载链路）。
 */
export async function getLibraryItemFile(
  libraryId: string,
  relPath: string,
): Promise<File | null> {
  const dir = getEntry(libraryId)?.handle;
  if (!dir) return null;
  return readFileBlob(dir, relPath);
}
