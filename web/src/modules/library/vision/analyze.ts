/**
 * M3.5.1 云端识图 · 单张全链路编排（任务卡 §4.9 流程钉死）。
 * 任一步异常 → {ok:false, error}，不写索引、不设 visionVersion=-1
 * （跳过标记由 5.2 队列负责，本卡禁止写）。
 */

import { readFileBlob } from "../../../core/storage/fsa";
import { getItem, getSettings, updateItem } from "../index/indexFile";
import type { LibraryTag } from "../index/indexFile";
import { compressForVision } from "./compress";
import { resolveEnabledFields } from "./fieldSchema";
import { buildPrompt } from "./prompt";
import { parseVisionResponse } from "./parse";
import { getProvider, setProviderRegion } from "./providers";
import type { VisionUsage } from "./providers";
import { loadVisionGlobal } from "./settings";

export const VISION_VERSION = 1;

export interface VisionRunResult {
  ok: boolean;
  itemId: string;
  usage?: VisionUsage;
  durationMs: number;
  error?: string;
}

/** tags 合并（钉死）：保留全部 manual；丢弃旧 auto；追加新 auto（跳过与 manual 文本重复的） */
function mergeTags(oldTags: LibraryTag[], newTags: string[]): LibraryTag[] {
  const manual = oldTags.filter((t) => t.source === "manual");
  const manualTexts = new Set(manual.map((t) => t.text));
  const auto: LibraryTag[] = newTags
    .filter((text) => !manualTexts.has(text))
    .map((text) => ({ text, source: "auto" as const }));
  return [...manual, ...auto];
}

export async function analyzeOne(
  dir: FileSystemDirectoryHandle,
  itemId: string,
  opts?: {
    providerOverride?: string;
    signal?: AbortSignal;
    /** 用原图重新分析（M3.5.3）：true 时忽略图库级压缩档位，一律 original */
    forceOriginal?: boolean;
  },
): Promise<VisionRunResult> {
  const started = Date.now();
  const fail = (error: string): VisionRunResult => ({
    ok: false,
    itemId,
    durationMs: Date.now() - started,
    error,
  });

  try {
    // 1. 条目必须存在
    const item = getItem(itemId);
    if (!item) return fail("item missing");

    // 2. 全局设置 + 图库级设置 + provider（未知 id 已由 getProvider 回退 minimax）
    const global = await loadVisionGlobal();
    const settings = getSettings();
    const provider = getProvider(opts?.providerOverride ?? global.providerId);

    // 2b. 当前供应商的 key 与模型分流（2026-09-26 任务卡 §4.4③④b）：
    //     自定义供应商用自己的 apiKey / model 字段（主界面 key 行 / 模型行写入），
    //     MiniMax 与 fake 走全局字段；providerOverride 点名 fake 自验时也走全局名下的值
    const customProvider = (global.customProviders ?? []).find(
      (p) => p.id === provider.id,
    );
    const apiKey = customProvider ? customProvider.apiKey : global.apiKey;
    const model = customProvider ? customProvider.model : global.model;

    // 3. 非 fake 且（未开总开关或无 key）→ 拒绝，不写索引
    if (!provider.fakeResponse && (!global.enabled || !apiKey)) {
      return fail("vision disabled or api key missing");
    }

    // 4. 读原图 → 按图库级档位压缩（失败抛错进 error）；forceOriginal 时一律原图
    const file = await readFileBlob(dir, item.relPath);
    if (!file) return fail("file missing");
    const image = await compressForVision(
      file,
      opts?.forceOriginal ? "original" : settings.compression,
    );

    // 5. 字段表 + 提示词
    const fields = resolveEnabledFields(settings.fieldConfig);
    const prompt = buildPrompt(fields, {
      head: settings.promptHead,
      tail: settings.promptTail,
    });

    // 6. 请求：fake 直接取 fakeResponse；真实走 fetch（60s 超时，signal 经 VisionRequest 传入）
    let text: string;
    let usage: VisionUsage;
    if (provider.fakeResponse) {
      const fake = provider.fakeResponse();
      text = fake.text;
      usage = fake.usage;
    } else {
      setProviderRegion(global.region);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        // 外部中止（队列 abortVisionRun）与 60s 超时共用一条中止链（AbortSignal.any，Chrome 116+）；
        // catch 按「外部 signal 是否已中止」区分：仅外部中止报 "aborted" 触发全队列退出，
        // 60s 超时是普通可重试失败（报请求超时文案，队列按 backoff 重试、不中止队列）
        const signal = AbortSignal.any(
          [controller.signal, opts?.signal].filter(
            (s): s is AbortSignal => !!s,
          ),
        );
        const { url, init } = provider.buildVisionRequest(
          {
            model,
            prompt,
            imageDataUrl: image.dataUrl,
            signal,
          },
          apiKey,
        );
        const response = await fetch(url, init);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = provider.parseResponse(await response.json());
        text = parsed.text;
        usage = parsed.usage;
      } finally {
        clearTimeout(timer);
      }
    }

    // 7. 解析 → 写回（浅合并字段；manual tag 保留、旧 auto 替换为新 auto）
    const parsed = parseVisionResponse(text, fields);
    updateItem(itemId, {
      description: parsed.description,
      fields: { ...item.fields, ...parsed.fields },
      extra: { ...item.extra, ...parsed.custom },
      tags: mergeTags(item.tags, parsed.tags),
      visionAt: Date.now(),
      visionVersion: VISION_VERSION,
    });
    return {
      ok: true,
      itemId,
      usage,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // 8. 任一步异常：不写索引、不设 visionVersion=-1
    if (err instanceof DOMException && err.name === "AbortError") {
      // M3.5.3.4 分链：外部中止（opts.signal 已 abort）→ 报 "aborted"，队列据此退出全队列；
      // 自身 60s 超时（外部 signal 未 abort）→ 报普通可重试失败文案，走 backoff 重试/终败，
      // 不再把超时放大成全队列中止（任务卡 4.5「超时留待重试」口径由队列重试路径承担）
      return opts?.signal?.aborted === true
        ? fail("aborted")
        : fail("请求超时（60s）");
    }
    return fail(String(err));
  }
}
