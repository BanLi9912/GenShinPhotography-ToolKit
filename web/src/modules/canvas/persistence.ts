import { BOARDS_STORE, getDB } from "../../core/storage/idb";
import { dismissToast, persistentToast } from "../../ui/toast";
import {
  assetCacheIds,
  deleteAssetsExcept,
  getAssetBlob,
  hasAsset,
  registerAsset,
} from "./assets";
import {
  useCanvasStore,
  type CanvasElement,
  type ImageElement,
  type Viewport,
} from "./store";

/**
 * 自动保存 + 会话恢复（任务 1.5）：
 * - store 的 elements/viewport 变更后 1 秒防抖，整篇写入 IndexedDB（§4.3 格式）
 * - 图片二进制存 assets 表，文档只存 blob-ref（见 assets.ts）
 * - 启动时读回：恢复元素与视角；每次保存后清理不再引用的孤本资产
 * - 页面隐藏/关闭时立即 flush，避免防抖窗口内丢掉最后一下操作
 */

/** M1 默认画板 id（多画板未排期，先单文档） */
const BOARD_ID = "canvas/default";
/** 操作后防抖时长（任务卡：1 秒） */
const AUTOSAVE_DELAY_MS = 1000;

/** §4.3 画布文档 */
interface BoardDoc {
  schemaVersion: 1;
  type: "ystk/board";
  meta: { name: string; createdAt: string; updatedAt: string };
  viewport: Viewport;
  elements: CanvasElement[];
  assets: { id: string; kind: "blob-ref"; ref: string }[];
}

let started = false;
/** 水合（restoreBoard）完成信号；重复调用返回同一 Promise（跨模块送图要等它） */
let startPromise: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 保存串行化：后一次保存读到的一定是最新状态，避免并发写交错 */
let saveChain: Promise<void> = Promise.resolve();
let revision = 0;
let savedRevision = 0;
let savePending = false;
let retryCount = 0;
const RETRY_DELAYS = [2000, 5000, 10000];
const SAVE_TOAST = "canvas-save";

function enqueueSave(): void {
  if (savePending || revision === savedRevision) return;
  savePending = true;
  saveChain = saveChain
    .then(async () => {
      const snapshotRevision = revision;
      await saveBoard();
      savedRevision = snapshotRevision;
      retryCount = 0;
      if (savedRevision === revision) dismissToast(SAVE_TOAST);
    })
    .catch((err) => {
      console.error("[canvas] 自动保存失败", err);
      persistentToast(SAVE_TOAST, "画布尚未保存成功，内容仍在内存中，请勿关闭页面。", {
        label: "重试保存",
        run: () => {
          retryCount = 0;
          persistentToast(SAVE_TOAST, "正在重试保存画布，请勿关闭页面…");
          flushSave();
        },
      });
      if (retryCount < RETRY_DELAYS.length) scheduleSave(RETRY_DELAYS[retryCount++]);
    })
    .finally(() => {
      savePending = false;
      // 写入期间的新编辑必须另存；失败超过重试上限则保留提示，等用户手动重试。
      if (revision !== savedRevision && retryCount === 0 && !timer) scheduleSave();
    });
}

function scheduleSave(delay = AUTOSAVE_DELAY_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    enqueueSave();
  }, delay);
}

/** 立即落盘（页面隐藏/关闭时调用，取消未决的防抖） */
function flushSave(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  enqueueSave();
}

async function saveBoard(): Promise<void> {
  const { elements, viewport } = useCanvasStore.getState();
  const db = await getDB();
  const prev = (await db.get(BOARDS_STORE, BOARD_ID)) as BoardDoc | undefined;
  const now = new Date().toISOString();
  const assetIds = [
    ...new Set(
      elements
        .filter((e): e is ImageElement => e.type === "image")
        .map((e) => e.props.assetId),
    ),
  ];
  const doc: BoardDoc = {
    schemaVersion: 1,
    type: "ystk/board",
    meta: {
      name: prev?.meta?.name ?? "未命名画布",
      createdAt: prev?.meta?.createdAt ?? now,
      updatedAt: now,
    },
    viewport,
    elements,
    assets: assetIds.map((id) => ({
      id,
      kind: "blob-ref",
      ref: `idb://assets/${id}`,
    })),
  };
  await db.put(BOARDS_STORE, doc, BOARD_ID);
  useCanvasStore.getState().setLastSavedAt(Date.now());
  // GC：删除不再被任何元素引用的资产；内存缓存中的保留（导入进行中，引用尚未形成）
  try {
    await deleteAssetsExcept(new Set([...assetIds, ...assetCacheIds()]));
  } catch (err) {
    // 文档已提交，清理失败不应被报成保存失败，也不因此重复写文档。
    console.warn("[canvas] 孤本资产清理失败", err);
  }
}

async function restoreBoard(): Promise<void> {
  const db = await getDB();
  const doc = (await db.get(BOARDS_STORE, BOARD_ID)) as BoardDoc | undefined;
  if (!doc) return;
  // 图片资产读回二进制 → objectURL 入缓存（ImageNode 渲染源）
  // 以下 `?? []` / `?? 默认视口`：文档字段缺失（写坏/半截文档）时降级恢复而不是抛错
  for (const asset of doc.assets ?? []) {
    if (asset.kind !== "blob-ref" || hasAsset(asset.id)) continue;
    const blob = await getAssetBlob(asset.id);
    if (blob) registerAsset(asset.id, blob);
  }
  // 丢弃资产缺失的图片元素（资产表被清空等异常，避免渲染空图）
  const validElements = (doc.elements ?? []).filter(
    (e) => e.type !== "image" || hasAsset(e.props.assetId),
  );
  // 丢弃悬空连线（fromId/toId 指向已不存在的元素）
  const validIds = new Set(validElements.map((e) => e.id));
  const elements = validElements.filter(
    (e) => {
      if (e.type !== "connector") return true;
      const ce = e as CanvasElement & { props: { fromId: string; toId: string } };
      return validIds.has(ce.props.fromId) && validIds.has(ce.props.toId);
    },
  );
  useCanvasStore
    .getState()
    .hydrate(elements, doc.viewport ?? { x: 0, y: 0, zoom: 1 });
}

/**
 * 启动持久化（CanvasPage 挂载时调用，重复调用幂等）：
 * 先读回上次画板，再订阅变更做防抖自动保存（避免恢复动作本身触发一次保存）。
 * 返回水合完成 Promise（M3.6：M3「送去画布」的待收图片要等水合完成才落图）。
 */
export function startCanvasPersistence(): Promise<void> {
  if (started) return startPromise ?? Promise.resolve();
  started = true;
  startPromise = restoreBoard()
    .catch((err) => console.error("[canvas] 会话恢复失败", err))
    .finally(() => {
      useCanvasStore.subscribe((s, prev) => {
        if (s.elements === prev.elements && s.viewport === prev.viewport)
          return;
        revision += 1;
        scheduleSave();
      });
      window.addEventListener("pagehide", flushSave);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushSave();
      });
    });
  return startPromise;
}
