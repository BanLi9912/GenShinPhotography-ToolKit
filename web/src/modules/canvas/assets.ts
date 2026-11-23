import { ASSETS_STORE, getDB } from "../../core/storage/idb";

/**
 * 图片资产（任务 1.5，§4.3 blob-ref）：二进制本体存 IndexedDB assets 表，
 * 元素 props 只存 assetId；渲染用 objectURL 挂在内存缓存。
 * 缓存只增不回收（页面重载即释放）；删除元素留下的孤本 blob 由
 * persistence 保存时的 GC 清理，缓存中的 id 视为"导入进行中"一律保留。
 */

/** assetId → objectURL（ImageNode 渲染源） */
const urlCache = new Map<string, string>();

/** 注册资产并返回渲染用 objectURL（导入/恢复时调用；先于写 IDB，防保存 GC 误删导入中的资产） */
export function registerAsset(id: string, blob: Blob): string {
  const existing = urlCache.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

/** 渲染用 objectURL；未注册（资产缺失）返回 null */
export function getAssetUrl(id: string): string | null {
  return urlCache.get(id) ?? null;
}

export function hasAsset(id: string): boolean {
  return urlCache.has(id);
}

/** 内存缓存中的全部资产 id（保存 GC 的保护名单用） */
export function assetCacheIds(): string[] {
  return [...urlCache.keys()];
}

/** 写入资产二进制（导入时调用） */
export async function putAssetBlob(id: string, blob: Blob): Promise<void> {
  const db = await getDB();
  await db.put(ASSETS_STORE, blob, id);
}

/** 读回资产二进制（会话恢复时调用）；缺失返回 null */
export async function getAssetBlob(id: string): Promise<Blob | null> {
  const db = await getDB();
  return ((await db.get(ASSETS_STORE, id)) as Blob | undefined) ?? null;
}

/**
 * 清理 keep 名单之外的孤本资产（每次保存后调用）。
 * 注意当前只有 M1 单画板；多画板时需合并所有文档的引用后再清理。
 */
export async function deleteAssetsExcept(
  keep: ReadonlySet<string>,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(ASSETS_STORE, "readwrite");
  const keys = await tx.store.getAllKeys();
  await Promise.all(
    keys.filter((k) => !keep.has(String(k))).map((k) => tx.store.delete(k)),
  );
  await tx.done;
}
