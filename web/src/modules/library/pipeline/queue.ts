/**
 * M3.2.1 分析队列（调度钉死）：主线程逐张分片，不引 Worker。
 * 任何时刻只处理 1 张，仅允许预取下一张的 Blob（磁盘 IO 与当前张的
 * decode/编码并行，createImageBitmap 本就在浏览器后台线程解码）；
 * 不并行 analyze、不引 Worker/OffscreenCanvas。
 * 两阶段编排（P1-10，分析拆两阶段）：
 * - Pass A（thumbs）：候选 = `thumb == null && pipelineVersion >= 0`（-1 跳过
 *   标记永不重试）；文件头嗅探原图尺寸 → `createImageBitmap` 缩放解码
 *   （≤960 双参）直出缩略图并写回 width/height——全分辨率位图不再物化；
 *   EXIF 5–8 横存竖图按显示方向调换尺寸并旋转回正（否则横竖错乱）；
 *   thumb 是核心产物，任何一步失败 → `-1` 跳过（防 null-thumb 死循环）。
 * - Pass B（stats）：候选 = `0 ≤ pipelineVersion < PIPELINE_VERSION`（Pass A
 *   结束后再筛，-1 已生效不重复计入）；读已落盘 thumb（几十 KB，不碰
 *   原图）跑 64²/32² 统计回填——patch 剔除 width/height（Pass A 已写原图
 *   尺寸，不得覆盖）；thumb 读不到/解码失败回退原图全解码，再失败 → -1。
 * `pipelineVersion === -1` 为跳过标记（解码失败防重跑死循环）。
 */
import { readFileBlob } from "../../../core/storage/fsa";
import { decodeImage } from "../../../core/imaging/sample";
import {
  currentGeneration,
  flush,
  listItems,
  updateItem,
} from "../index/indexFile";
import { analyzeImage, PIPELINE_VERSION } from "./basicAnalysis";
import { makeThumb, THUMB_EDGE } from "./thumbs";
import { sniffDimensions } from "./sniff";

export type AnalysisStage = "thumbs" | "stats";

export interface AnalysisProgress {
  stage: AnalysisStage;
  total: number;
  done: number;
  perSecond: number;
  /** 预计剩余秒数；速度未知（窗口内无完成或 <0.1 张/秒）时为 null */
  etaSeconds: number | null;
  paused: boolean;
  failed: number;
}

export interface AnalysisCallbacks {
  onProgress: (progress: AnalysisProgress) => void;
  isPaused: () => boolean;
}

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 最近 10 秒滑动窗口完成数 ÷ 窗口实际跨度秒（<1s 按 1s 防启动虚高；空窗 = 0） */
function toProgress(
  stage: AnalysisStage,
  total: number,
  done: number,
  stamps: number[],
  paused: boolean,
  failed: number,
): AnalysisProgress {
  const now = Date.now();
  while (stamps.length > 0 && now - stamps[0] > 10000) stamps.shift();
  const perSecond =
    stamps.length === 0
      ? 0
      : Math.round((stamps.length / Math.max(1, (now - stamps[0]) / 1000)) * 10) / 10;
  return {
    stage,
    total,
    done,
    perSecond,
    etaSeconds:
      perSecond >= 0.1 ? Math.ceil((total - done) / perSecond) : null,
    paused,
    failed,
  };
}

/**
 * EXIF 5–8 横存竖图（M3.2.1 修复）：Chromium 的 `createImageBitmap(blob,
 * {resizeWidth…})` **先应用 EXIF 旋转再按参数缩放**（参数按原始轴给 → 内容
 * 被拉伸变形；按显示轴给 → 又双旋转），只有不带 resize 的全解码才返回
 * 取向正确的位图。故 EXIF 文件走「全解码 → 画布缩放到 ≤960」；
 * 注：EXIF 文件因此无法享受 Pass A 的缩放解码省内存路径（全分辨率位图
 * 短暂物化，仅限 5–8 朝向、每张一次）。
 */
async function decodeOriented(bitmap: ImageBitmap): Promise<ImageBitmap> {
  if (bitmap.width <= THUMB_EDGE && bitmap.height <= THUMB_EDGE) return bitmap;
  const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
  const cw = Math.max(1, Math.round(bitmap.width * scale));
  const ch = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  try {
    const scaled = await createImageBitmap(canvas);
    bitmap.close();
    return scaled;
  } catch (err) {
    bitmap.close();
    throw err;
  }
}

/**
 * 跑一轮分析队列（两阶段顺序跑，共用同一 onProgress 通道）：
 * Pass A 缩略图先行 → Pass B 统计后台跑；总失败数 = 两阶段之和返回；
 * 切库代次变化立即中止。
 */
export async function runAnalysisQueue(
  dir: FileSystemDirectoryHandle,
  callbacks: AnalysisCallbacks,
): Promise<{ failed: number }> {
  const gen = currentGeneration();

  const passA = listItems()
    .filter(
      (item) =>
        item.thumb == null &&
        typeof item.pipelineVersion === "number" &&
        item.pipelineVersion >= 0,
    )
    // 视口优先：网格默认按 mtime 降序展示，Pass A 同序处理 → 最新/首屏条目
    // 最先出缩略图。扫描顺序≈时间升序（手机照片典型），不排序则首屏内容排在
    // 队列 95%+ 位置——1650 张大库在进度 90% 前网格全占位（用户实测观感
    // 「所有计算完成才开始排」）。
    .sort((a, b) => b.mtime - a.mtime);

  const stamps: number[] = [];
  let failed = 0;
  let stage: AnalysisStage = "thumbs";
  let total = 0;
  let done = 0;
  let lastReport = 0;

  const report = (paused: boolean) => {
    callbacks.onProgress(
      toProgress(stage, total, done, stamps, paused, failed),
    );
  };

  /* ---- Pass A：缩略图先行（缩放解码，全分辨率位图不再物化） ---- */

  if (passA.length > 0) {
    stage = "thumbs";
    total = passA.length;
    done = 0;
    stamps.length = 0;
    lastReport = 0;
    // 阶段启动立即报 total：消灭「0/0」窗口
    callbacks.onProgress(
      toProgress("thumbs", total, 0, [], callbacks.isPaused(), failed),
    );

    // 预取流水线：循环外发起第一张读盘；当前张解码/编码与下一张读盘并行
    // （只读盘预取，任何时刻仍只处理 1 张）
    let nextRead: Promise<File | null> | null = null;
    const prefetch = (index: number) => {
      nextRead =
        index < passA.length
          ? readFileBlob(dir, passA[index].relPath).catch((err) => {
              console.warn(
                "[library] Pass A 预取读盘失败",
                passA[index].relPath,
                err,
              );
              return null;
            })
          : null;
    };

    prefetch(0);
    for (let i = 0; i < passA.length; i++) {
      if (currentGeneration() !== gen) return { failed };
      const item = passA[i];
      const blobPromise = nextRead;
      prefetch(i + 1);
      try {
        const file = await blobPromise;
        if (!file) throw new Error("file missing");
        // 文件头嗅探原图尺寸 → 缩放解码双参（只给一个会拉伸）；
        // 嗅探失败（null）回退全解码，尺寸取位图实际值
        const dims = await sniffDimensions(file);
        let bitmap: ImageBitmap;
        if (dims) {
          if (dims.orientation !== undefined && dims.orientation >= 5) {
            // 横存竖图（EXIF 5–8）：sniff 已按显示方向调换宽高；全解码取向
            // 位图再画布缩放（见 decodeOriented 注释：resize 参数路径会拉伸）
            bitmap = await decodeOriented(await decodeImage(file));
          } else {
            const scale = Math.min(1, THUMB_EDGE / Math.max(dims.width, dims.height));
            bitmap = await createImageBitmap(file, {
              resizeWidth: Math.round(dims.width * scale),
              resizeHeight: Math.round(dims.height * scale),
              resizeQuality: "high",
            });
          }
        } else {
          bitmap = await decodeImage(file);
        }
        try {
          const thumb = await makeThumb(dir, bitmap, item.id);
          if (!thumb) throw new Error("thumb encode failed");
          updateItem(item.id, {
            thumb,
            width: dims ? dims.width : bitmap.width,
            height: dims ? dims.height : bitmap.height,
          });
        } finally {
          // 解码位图用完立即释放（不占内存等 GC；大图库逐张流式）
          bitmap.close();
        }
      } catch (err) {
        console.warn("[library] Pass A 分析失败，跳过", item.relPath, err);
        updateItem(item.id, { pipelineVersion: -1 });
        failed += 1;
      }
      done += 1;
      stamps.push(Date.now());

      // 每条之间让出主线程并检查暂停（对齐 scan.ts 的可暂停调度模式）
      await yieldToUI();
      while (callbacks.isPaused()) {
        report(true);
        await sleep(500);
      }
      // 250ms 时间闸（进度真实化，速度不再被 16 条粒度截断）
      const now = Date.now();
      if (now - lastReport >= 250) {
        report(callbacks.isPaused());
        lastReport = now;
      }
    }
    // 阶段末尾补发一次
    report(callbacks.isPaused());
  }

  /* ---- Pass B：统计后台跑（读已落盘 thumb，不碰原图） ---- */

  const passB = listItems().filter(
    (item) =>
      typeof item.pipelineVersion === "number" &&
      item.pipelineVersion >= 0 &&
      item.pipelineVersion < PIPELINE_VERSION,
  );
  if (passB.length > 0) {
    stage = "stats";
    total = passB.length;
    done = 0;
    stamps.length = 0;
    lastReport = 0;
    callbacks.onProgress(
      toProgress("stats", total, 0, [], callbacks.isPaused(), failed),
    );

    for (const item of passB) {
      if (currentGeneration() !== gen) return { failed };
      try {
        // 优先读已落盘 thumb（几十 KB）；thumb 文件缺失/解码失败回退原图全解码
        let bitmap: ImageBitmap | null = null;
        if (item.thumb) {
          const thumbFile = await readFileBlob(dir, `.ystk/${item.thumb}`);
          if (thumbFile) {
            try {
              bitmap = await decodeImage(thumbFile);
            } catch {
              bitmap = null;
            }
          }
        }
        if (!bitmap) {
          const file = await readFileBlob(dir, item.relPath);
          if (!file) throw new Error("file missing");
          bitmap = await decodeImage(file);
        }
        try {
          const patch = analyzeImage(bitmap);
          // width/height 由 Pass A 写入原图尺寸，统计 patch 不得覆盖
          const { width: _w, height: _h, ...statsPatch } = patch;
          updateItem(item.id, statsPatch);
        } finally {
          bitmap.close();
        }
      } catch (err) {
        console.warn("[library] Pass B 分析失败，跳过", item.relPath, err);
        updateItem(item.id, { pipelineVersion: -1 });
        failed += 1;
      }
      done += 1;
      stamps.push(Date.now());

      await yieldToUI();
      while (callbacks.isPaused()) {
        report(true);
        await sleep(500);
      }
      const now = Date.now();
      if (now - lastReport >= 250) {
        report(callbacks.isPaused());
        lastReport = now;
      }
    }
    report(callbacks.isPaused());
  }

  // 收尾落盘不阻塞 `.then` 里的识图串联与 running 复位（1s 防抖、每 100 条
  // 兜底、pagehide best-effort 三重仍在，此处只是冗余保险；失败只记日志）
  void flush().catch((err) =>
    console.error("[library] 分析收尾落盘失败", err),
  );
  // 收尾补发：两阶段都空时按 0/0 终态报一次，否则维持最后阶段满格口径
  report(callbacks.isPaused());
  return { failed };
}
