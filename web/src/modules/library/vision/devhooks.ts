/**
 * M3.5.1/5.2 云端识图 · dev 验收钩子（仅 DEV 注册；严禁触磁盘以外副作用）。
 * 挂载点：components/LibraryPage.tsx 的 dev 块末尾 registerVisionDevHooks()。
 */

/* eslint-disable no-console -- dev 验收钩子（仅 DEV 注册） */

import { useLibraryStore } from "../store";
import { getEntry } from "../index/binding";
import { flush, getItem, getSettings, listItems } from "../index/indexFile";
import type { VisionRunResult } from "./analyze";
import { analyzeOne } from "./analyze";
import { resolveEnabledFields } from "./fieldSchema";
import { buildPrompt } from "./prompt";
import type { VisionParsed } from "./parse";
import { parseVisionResponse } from "./parse";
import { runVisionQueue } from "./queue";

declare global {
  interface Window {
    /** M3.5.1 验收：容错解析（fieldConfig 可选，缺省默认字段表），console.log 入出参并返回结果 */
    __ystkVisionParse?: (
      text: string,
      fieldConfig?: Record<string, unknown>,
    ) => VisionParsed;
    /** M3.5.1 验收：按字段配置拼装提示词（缺省用当前图库 fieldConfig），console.log 并返回 */
    __ystkVisionPrompt?: (fieldConfig?: Record<string, unknown>) => string;
    /** M3.5.1 验收：单张全链路（默认 provider=fake），flush 后返回 result */
    __ystkVisionTest?: (
      itemId?: string,
      providerId?: string,
    ) => Promise<VisionRunResult>;
    /** M3.5.2 验收：当前图库跑识图队列（fake 放行），console.log 每次进度与终态 */
    __ystkVisionQueue?: () => Promise<{ done: number; failed: number }>;
    /** M3.5.2 验收：重试桩——目标条目前 2 次 mock fail、第 3 次转真，backoff [10,20,40] */
    __ystkVisionRetryTest?: () => Promise<{ done: number; failed: number }>;
  }
}

export function registerVisionDevHooks(): void {
  if (!import.meta.env.DEV) return;

  window.__ystkVisionParse = (
    text: string,
    fieldConfig?: Record<string, unknown>,
  ) => {
    const result = parseVisionResponse(
      text,
      resolveEnabledFields(fieldConfig ?? {}),
    );
    console.log("[vision] parse 入参", text, fieldConfig);
    console.log("[vision] parse 结果", result);
    return result;
  };

  window.__ystkVisionPrompt = (fieldConfig?: Record<string, unknown>) => {
    const s = getSettings();
    const prompt = buildPrompt(resolveEnabledFields(fieldConfig ?? s.fieldConfig), {
      head: s.promptHead,
      tail: s.promptTail,
    });
    console.log("[vision] prompt", prompt);
    return prompt;
  };

  window.__ystkVisionTest = async (itemId?: string, providerId = "fake") => {
    const current = useLibraryStore.getState().current;
    if (!current) {
      const message = "未绑定图库：请先绑定并扫描一个图库";
      console.error("[vision]", message);
      throw new Error(message);
    }
    const entry = getEntry(current.libraryId);
    if (!entry) {
      const message = "图库句柄缺失";
      console.error("[vision]", message);
      throw new Error(message);
    }
    const target = itemId ?? listItems()[0]?.id;
    if (!target) {
      const message = "图库无条目";
      console.error("[vision]", message);
      throw new Error(message);
    }
    const result = await analyzeOne(entry.handle, target, {
      providerOverride: providerId,
    });
    console.log("[vision] analyzeOne 结果", result);
    console.log("[vision] 写回后 item", getItem(target));
    await flush();
    return result;
  };

  window.__ystkVisionQueue = async () => {
    const current = useLibraryStore.getState().current;
    if (!current) throw new Error("未绑定图库");
    const entry = getEntry(current.libraryId);
    if (!entry) throw new Error("图库句柄缺失");
    const result = await runVisionQueue(entry.handle, {
      onProgress: (p) => console.log("[vision] queue progress", p),
    });
    console.log("[vision] queue 终态", result);
    return result;
  };

  window.__ystkVisionRetryTest = async () => {
    const current = useLibraryStore.getState().current;
    if (!current) throw new Error("未绑定图库");
    const entry = getEntry(current.libraryId);
    if (!entry) throw new Error("图库句柄缺失");
    const target = listItems()[0];
    if (!target) throw new Error("图库无条目");
    let tries = 0;
    const stub: typeof analyzeOne = async (dir, itemId, opts) => {
      tries += 1;
      console.log(`[vision] retryTest 第 ${tries} 次尝试 (item=${itemId})`);
      if (tries <= 2 && itemId === target.id) {
        return { ok: false, itemId, durationMs: 0, error: "mock fail" };
      }
      return analyzeOne(dir, itemId, opts);
    };
    const result = await runVisionQueue(
      entry.handle,
      {
        onProgress: (p) => console.log("[vision] retryTest progress", p),
      },
      { runOne: stub, backoffMs: [10, 20, 40], itemIds: [target.id] },
    );
    console.log("[vision] retryTest 终态", result, "tries=", tries);
    return result;
  };
}
