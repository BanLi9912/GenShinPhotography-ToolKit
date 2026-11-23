/**
 * 任务 M3.1 · 全量扫描 + 增量比对 + 重命名对位 + 可暂停调度（M3.2.1 单遍化）。
 * 只登记图片文件（七种扩展名白名单，规划 §3 M3.1 / §6）；不读像素、不做分析。
 * 单遍目录树边扫边报：total 未知（0）直到遍历结束，UI 降级为「已扫描 X 张」；
 * 进度与暂停状态经 callbacks 回写 store（本文件不 import store，避免循环依赖）。
 */

import { walkDirectory } from "../../../core/storage/fsa";
import {
  createItem,
  currentGeneration,
  flush,
  listItems,
  removeItem,
  updateItem,
  upsertItem,
} from "./indexFile";

/** 扫描白名单扩展名（钉死；raw/视频/其他一律不登记） */
const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "avif",
]);

export interface ScanProgress {
  total: number;
  done: number;
  perSecond: number;
  paused: boolean;
}

export interface ScanCallbacks {
  onProgress: (progress: ScanProgress) => void;
  isPaused: () => boolean;
}

function isImage(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(relPath.slice(dot + 1).toLowerCase());
}

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 最近 10 秒滑动窗口完成数 ÷ 窗口实际跨度秒（<1s 按 1s 防启动虚高；空窗 = 0） */
function toProgress(
  total: number,
  done: number,
  stamps: number[],
  paused: boolean,
): ScanProgress {
  const now = Date.now();
  while (stamps.length > 0 && now - stamps[0] > 10000) stamps.shift();
  const perSecond =
    stamps.length === 0
      ? 0
      : Math.round((stamps.length / Math.max(1, (now - stamps[0]) / 1000)) * 10) / 10;
  return { total, done, perSecond, paused };
}

/**
 * 执行一次全量扫描（首次 = 全量新增，之后 = 增量比对）：
 * 1. relPath 存在且 mtime+size 相同 → 不变；
 * 2. relPath 存在但 mtime/size 不同 → 更新（id 保留）；
 * 3. relPath 不存在 → 与本次消失条目按 mtime+size 完全相等对位，
 *    唯一命中视为重命名（保留原 id）；零/多命中视为新文件；
 * 4. 扫描结束仍消失的条目 → 删除。
 * 每处理 50 条让出主线程并检查暂停；暂停时轮询等待，恢复后从断点继续
 * （生成器保持不重建）。进度按 250ms 时间闸上报（单遍扫无预遍历，
 * total 未知 = 0，扫描结束才补报满格 total = done）。
 */
export async function startScan(
  dir: FileSystemDirectoryHandle,
  callbacks: ScanCallbacks,
): Promise<void> {
  const gen = currentGeneration();
  // 单遍扫描：total 未知（0）；先报一次消灭无反馈期
  callbacks.onProgress({ total: 0, done: 0, perSecond: 0, paused: callbacks.isPaused() });

  const byRelPath = new Map(listItems().map((item) => [item.relPath, item]));
  const disappeared = new Map(byRelPath);
  const stamps: number[] = [];
  let done = 0;
  let lastReport = 0;
  // M3.4.2 R2 汇总日志计数：不变/变更（mtime 或 size 漂移）/新增/重命名/删除
  let unchangedCount = 0;
  let changedCount = 0;
  let addedCount = 0;
  let renamedCount = 0;
  /** 变更明细（前 3 条留诊断：区分 size 漂移与纯 mtime 漂移） */
  const driftDetails: {
    relPath: string;
    oldMtime: number;
    newMtime: number;
    oldSize: number;
    newSize: number;
  }[] = [];

  for await (const entry of walkDirectory(dir)) {
    if (currentGeneration() !== gen) return; // 图库已切换/解绑，放弃本次扫描
    if (!isImage(entry.relPath)) continue;
    done += 1;
    stamps.push(Date.now());

    const old = byRelPath.get(entry.relPath);
    if (old) {
      disappeared.delete(entry.relPath);
      if (old.mtime !== entry.mtime || old.size !== entry.size) {
        changedCount += 1;
        driftDetails.push({
          relPath: entry.relPath,
          oldMtime: old.mtime,
          newMtime: entry.mtime,
          oldSize: old.size,
          newSize: entry.size,
        });
        // M3.4.2 R2 判定两级化（前提：云盘/同步客户端只改 mtime 元数据）：
        // size 变 = 真变更 → 维持全量重置；同尺寸仅 mtime 漂移 → 视为内容未变，
        // 只更新 mtime 不重跑分析（接受「同尺寸改内容」漏检，__ystkReanalyzeAll 兜底）
        if (old.size !== entry.size) {
          // 内容变了必须重分析：清空管线版本/分析时间/缩略图/尺寸（M3.2.1 修复：
          // 旧 thumb 与旧尺寸不重置会被 Pass A 的「thumb == null」候选漏掉，
          // 导致修改过的图沿用裁剪前尺寸/画面——Pass A 将重新嗅探并生成）
          updateItem(old.id, {
            mtime: entry.mtime,
            size: entry.size,
            pipelineVersion: 0,
            analyzedAt: null,
            thumb: null,
            width: null,
            height: null,
          });
        } else {
          updateItem(old.id, { mtime: entry.mtime });
        }
      } else {
        unchangedCount += 1;
      }
    } else {
      const candidates = [...disappeared.values()].filter(
        (item) => item.mtime === entry.mtime && item.size === entry.size,
      );
      if (candidates.length === 1) {
        const renamed = candidates[0];
        disappeared.delete(renamed.relPath);
        renamedCount += 1;
        // 重命名对位：保留原 id，只更新 relPath/mtime/size
        updateItem(renamed.id, {
          relPath: entry.relPath,
          mtime: entry.mtime,
          size: entry.size,
        });
      } else {
        // 零命中 = 新文件；多命中 = mtime+size 相同的消失条目不止一个，
        // 无法唯一对位，按新文件登记（pHash 内容对位属 M3.2 之后）
        upsertItem(createItem(entry.relPath, entry.mtime, entry.size));
        addedCount += 1;
      }
    }

    if (done % 50 === 0) {
      await yieldToUI();
      while (callbacks.isPaused()) {
        callbacks.onProgress(toProgress(0, done, stamps, true));
        await sleep(500);
      }
    }
    // 250ms 时间闸（进度真实化：慢扫/快扫都保持反馈节奏，速度不再被条数截断）
    const now = Date.now();
    if (now - lastReport >= 250) {
      callbacks.onProgress(toProgress(0, done, stamps, callbacks.isPaused()));
      lastReport = now;
    }
  }

  // 防误删护栏（M3.2.3）：本次枚举到 0 个文件但缓存非空 → 疑似目录枚举
  // 异常/权限抖动（云盘/权限瞬态），跳过整个消失删除，避免索引被整库误删
  // （ready 空网格同为黑屏候选根因之一）；正常枚举下的真消失删除不受影响
  let deletedCount = 0;
  if (done === 0 && byRelPath.size > 0) {
    console.error(
      `[library] 本次扫描枚举到 0 个文件但缓存非空（疑似目录枚举异常/权限抖动），已跳过消失删除，保留全部 ${byRelPath.size} 条`,
    );
  } else {
    for (const item of disappeared.values()) {
      if (currentGeneration() !== gen) return;
      removeItem(item.id);
      deletedCount += 1;
    }
  }
  // F3 护栏对称（2026-09-17）：上方护栏防"枚举 0 文件"，此处防"载入 0 条"——
  // 索引读失败会让所有文件走新增重建、识图信息尽失。只告警不阻断（删 .ystk 重建是
  // 合法流程，真正的防线是 indexFile 的 F1 读失败防御）。
  if (byRelPath.size === 0 && done > 0) {
    console.warn(
      `[library] 索引载入 0 条但目录枚举到 ${done} 个图片文件——若非新图库/刻意删除 .ystk，请检查 index.json 是否读取失败`,
    );
  }

  // M3.4.2 R2.1 汇总日志（永久保留）：变更 > 0 时附前 3 条明细（区分 mtime/size 漂移，
  // 供「进图库总重跑」实测诊断；mtime 用 ISO 串打印）
  console.log(
    `[library] 扫描比对：不变 ${unchangedCount} · 变更 ${changedCount} · 新增 ${addedCount} · 重命名 ${renamedCount} · 删除 ${deletedCount}`,
  );
  if (changedCount > 0) {
    console.warn(
      "[library] 变更明细（前 3 条）：" +
        driftDetails
          .slice(0, 3)
          .map((d) =>
            JSON.stringify({
              relPath: d.relPath,
              oldMtime: new Date(d.oldMtime).toISOString(),
              newMtime: new Date(d.newMtime).toISOString(),
              oldSize: d.oldSize,
              newSize: d.newSize,
            }),
          )
          .join(", "),
    );
  }
  // 收尾：先报满格（total = done）；尾部 flush 不阻塞 ready——1s 防抖、每
  // 100 条兜底、pagehide best-effort 三重落盘仍在，尾部 flush 只是冗余保险；
  // 落盘失败只记日志，startScan 在满格上报后同步返回（ready 永远不许等磁盘）
  callbacks.onProgress(toProgress(done, done, stamps, callbacks.isPaused()));
  void flush().catch((err) => console.error("[library] 扫描收尾落盘失败", err));
}
