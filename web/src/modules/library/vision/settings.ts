/**
 * M3.5.1 云端识图 · 全局设置（规划 D6 全局级，存 IndexedDB `settings` 表）。
 * 跨图库共享；图库级设置（compression/presetId/fieldConfig）在
 * index/indexFile.ts 的 LibrarySettings（meta.json settings 字段）。
 */

import { getDB, SETTINGS_STORE } from "../../../core/storage/idb";
import { setCustomProviders } from "./providers";

/**
 * 自定义供应商配置（OpenAI 兼容 chat/completions，2026-09-26 任务卡）：
 * 类型定义放本文件（providers.ts 只单向 import 本类型，避免模块成环）。
 */
export interface CustomProviderConfig {
  /** `custom-` + 8 位随机 hex（生成口径对齐 binding.randomLibraryId 的随机段） */
  id: string;
  /** 用户起名，显示在 provider 下拉 */
  name: string;
  /** API 基地址（如 https://api.siliconflow.cn/v1）；请求 = `${baseUrl}/chat/completions` */
  baseUrl: string;
  /** 该供应商自己的 API key（存储一供应商一份；输入 UI 复用主界面现有 API key 行，
   *  该行绑定当前选中供应商的 key——MiniMax 时读写全局 apiKey 字段，自定义时读写
   *  本字段；弹窗不含 key 输入） */
  apiKey: string;
  /** 该供应商当前使用的模型 id（输入 UI 复用主界面模型行——自定义供应商时该行
   *  为自由文本输入，读写本字段；MiniMax 仍走全局 model 字段） */
  model: string;
  /** 该供应商当前模型的单价（元/1M tokens，语义同全局三字段；缺省 0 = 不计金额） */
  priceInput?: number;
  priceCached?: number;
  priceOutput?: number;
}

/** 全局识图设置（缺字段时合并默认值） */
export interface VisionGlobalSettings {
  /** M3.4.5 搜索引擎：词典（现状）/ 向量（Ollama bge-m3 余弦检索） */
  searchEngine: "dict" | "vector";
  /** M3.4.5 Ollama 端点（向量引擎用） */
  ollamaEndpoint: string;
  /** M3.4.5 嵌入模型（向量引擎用；换模型全库重嵌） */
  ollamaModel: string;
  providerId: string; // 默认 "minimax"
  /** API key 明文存 idb（规划 D6/§6：口令加密列为不做项） */
  apiKey: string;
  /** 识图总开关，默认 false（开关 + 填 key 才走云端） */
  enabled: boolean;
  concurrency: number; // 默认 3
  region: "cn" | "intl"; // 默认 "cn"（D5 端点分行）
  model: string; // 默认 "MiniMax-VL-01"（候选 ID，联调可改）
  /** 元 / 1M input tokens（MiniMax 官方定价随时调整，由用户按账单填写；D5 参考：缓存命中 0.84 元/M） */
  priceInput: number;
  /** 元 / 1M output tokens */
  priceOutput: number;
  /** 元 / 1M cached tokens */
  priceCached: number;
  /** 本轮预算上限（元，默认 0 = 不限；只计本轮 cost.amount，命中即中止） */
  budgetLimit: number;
  /** 新增图片自动开始识图（默认 true）：重扫后新图/改图自动识图；
   *  关闭后改弹识图小窗手动确认（2026-08-23 用户需求） */
  autoRecognizeNew: boolean;
  /** 用户自定义供应商（2026-09-26，OpenAI 兼容）；空数组 = 无 */
  customProviders: CustomProviderConfig[];
}

const KEY = "vision-global";
const COST_KEY = "vision-cost-total";

/** 累计识图成本（跨图库；同 SETTINGS_STORE，key 固定 vision-cost-total） */
export interface VisionCostTotal {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** 累计金额（元） */
  amount: number;
  /** 累计识图张数 */
  images: number;
}

function defaultVisionGlobal(): VisionGlobalSettings {
  return {
    searchEngine: "dict",
    ollamaEndpoint: "http://localhost:11434",
    ollamaModel: "bge-m3",
    providerId: "minimax",
    apiKey: "",
    enabled: false,
    concurrency: 3,
    region: "cn",
    model: "MiniMax-VL-01",
    priceInput: 0,
    priceOutput: 0,
    priceCached: 0,
    budgetLimit: 0,
    autoRecognizeNew: true,
    customProviders: [],
  };
}

function defaultCostTotal(): VisionCostTotal {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    amount: 0,
    images: 0,
  };
}

/** 读全局设置：缺字段合并默认值（读侧同步自定义供应商表，先例同 setProviderRegion） */
export async function loadVisionGlobal(): Promise<VisionGlobalSettings> {
  const db = await getDB();
  const stored = (await db.get(SETTINGS_STORE, KEY)) as
    | Partial<VisionGlobalSettings>
    | undefined;
  // customProviders 逐项补价格默认 0：存量自定义供应商没有这三个字段，
  // 防 undefined 进受控输入（React 受控警告）与金额计算（NaN）
  const settings = {
    ...defaultVisionGlobal(),
    ...(stored ?? {}),
    customProviders: ((stored?.customProviders ?? []) as CustomProviderConfig[]).map(
      (p) => ({ priceInput: 0, priceCached: 0, priceOutput: 0, ...p }),
    ),
  };
  setCustomProviders(settings.customProviders);
  return settings;
}

/** 写全局设置：与现存值合并后整条落盘（串行链防快速连改的读写竞态） */
let saveChain: Promise<void> = Promise.resolve();
export function saveVisionGlobal(
  patch: Partial<VisionGlobalSettings>,
): Promise<void> {
  saveChain = saveChain.then(async () => {
    const db = await getDB();
    const current = await loadVisionGlobal();
    // 写侧同步：任何路径写入的增删改都即时反映到 provider 表（先例同 setProviderRegion）
    setCustomProviders(patch.customProviders ?? current.customProviders);
    await db.put(SETTINGS_STORE, { ...current, ...patch }, KEY);
  });
  return saveChain;
}

/** 读累计成本：缺省全 0 */
export async function loadVisionCostTotal(): Promise<VisionCostTotal> {
  const db = await getDB();
  const stored = (await db.get(SETTINGS_STORE, COST_KEY)) as
    | Partial<VisionCostTotal>
    | undefined;
  return { ...defaultCostTotal(), ...(stored ?? {}) };
}

/** 累计成本逐项累加落盘，返回新值 */
export async function addVisionCostTotal(
  delta: Partial<VisionCostTotal>,
): Promise<VisionCostTotal> {
  const db = await getDB();
  const current = await loadVisionCostTotal();
  const next: VisionCostTotal = {
    promptTokens: current.promptTokens + (delta.promptTokens ?? 0),
    completionTokens: current.completionTokens + (delta.completionTokens ?? 0),
    cachedTokens: current.cachedTokens + (delta.cachedTokens ?? 0),
    amount: current.amount + (delta.amount ?? 0),
    images: current.images + (delta.images ?? 0),
  };
  await db.put(SETTINGS_STORE, next, COST_KEY);
  return next;
}

/** 累计成本清零 */
export async function resetVisionCostTotal(): Promise<void> {
  const db = await getDB();
  await db.delete(SETTINGS_STORE, COST_KEY);
}
