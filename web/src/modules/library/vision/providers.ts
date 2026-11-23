/**
 * M3.5.1 云端识图 · Provider 抽象表（规划 D5 结构钉死）。
 * MiniMax 默认（OpenAI 兼容 chat/completions）+ 内置 fake provider（无 key 自验全链路）。
 *
 * 区域说明：VisionRequest 不含区域字段，端点解析所需区域由 analyze 发请求前
 * 经 `setProviderRegion` 写入模块级缓存（全局设置 load 后同步）。
 */

import { ONE_SHOT } from "./prompt";
import type { CustomProviderConfig } from "./settings";

export interface VisionUsage {
  promptTokens: number;
  completionTokens: number;
  /** MiniMax usage.cached_tokens（D5 缓存命中统计，5.2 成本用） */
  cachedTokens?: number;
}

export interface VisionRequest {
  model: string;
  /** 完整静态提示词（前置，缓存前缀） */
  prompt: string;
  /** base64 data URL（后置） */
  imageDataUrl: string;
  signal: AbortSignal;
}

export interface VisionProvider {
  id: string;
  name: string;
  models: string[];
  /** 端点按账号区域解析（D5）；无区域差异的 provider 返回固定串 */
  endpoint(region: "cn" | "intl"): string;
  keyHeader: string; // "Authorization"
  keyPrefix: string; // "Bearer "
  buildVisionRequest(
    req: VisionRequest,
    apiKey: string,
  ): { url: string; init: RequestInit };
  parseResponse(json: unknown): { text: string; usage: VisionUsage };
  /** fake provider 专用：存在则 analyze 跳过 fetch 直接用它当模型输出 */
  fakeResponse?: () => { text: string; usage: VisionUsage };
}

/** 当前账号区域（analyze 发请求前按全局设置写入；buildVisionRequest 用它解析端点） */
let activeRegion: "cn" | "intl" = "cn";

export function setProviderRegion(region: "cn" | "intl"): void {
  activeRegion = region;
}

const minimax: VisionProvider = {
  id: "minimax",
  name: "MiniMax",
  models: ["MiniMax-VL-01"],
  endpoint(region) {
    // 来源：platform.minimaxi.com 官方文档（大陆/国际账号分行），以真实 key 联调为准
    return region === "cn"
      ? "https://api.minimaxi.com/v1"
      : "https://api.minimax.io/v1";
  },
  keyHeader: "Authorization",
  keyPrefix: "Bearer ",
  buildVisionRequest(req, apiKey) {
    return {
      url: `${this.endpoint(activeRegion)}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: req.model,
          messages: [
            {
              role: "user",
              // 静态提示词前置、图片后置，对齐 D5 自动 prompt 缓存的前缀匹配要求
              content: [
                { type: "text", text: req.prompt },
                { type: "image_url", image_url: { url: req.imageDataUrl } },
              ],
            },
          ],
        }),
        signal: req.signal,
      },
    };
  },
  parseResponse(json) {
    const root = json as
      | {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: Record<string, unknown>;
        }
      | null
      | undefined;
    if (!root || typeof root !== "object") {
      throw new Error("MiniMax 响应结构缺失");
    }
    const content = root.choices?.[0]?.message?.content;
    let text: string;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // 容忍 content 为数组拼段（多段 content 拼接）
      text = content
        .map((seg) => {
          if (!seg || typeof seg !== "object") return "";
          const t = (seg as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        })
        .join("");
    } else {
      throw new Error("MiniMax 响应缺少 choices[0].message.content");
    }
    const usage = root.usage ?? {};
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    return {
      text,
      usage: {
        promptTokens: num(usage.prompt_tokens),
        completionTokens: num(usage.completion_tokens),
        cachedTokens: num(usage.cached_tokens),
      },
    };
  },
};

const fake: VisionProvider = {
  id: "fake",
  name: "Fake（无 key 自验）",
  models: ["fake-vision"],
  endpoint: () => "about:blank",
  keyHeader: "",
  keyPrefix: "",
  // 直通实现：fake 走 fakeResponse，不经 fetch（不会被调用）
  buildVisionRequest: () => ({ url: "about:blank", init: {} }),
  parseResponse(json) {
    const root = json as { text?: unknown } | null | undefined;
    return {
      text: root && typeof root.text === "string" ? root.text : "",
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    };
  },
  fakeResponse: () => ({
    text: JSON.stringify(ONE_SHOT),
    usage: { promptTokens: 512, completionTokens: 180, cachedTokens: 0 },
  }),
};

export const PROVIDERS: VisionProvider[] = [minimax, fake];

/* ------------------------------------------------------------------ *
 * 自定义供应商（2026-09-26）：OpenAI 兼容模板 + dev server 代理转发
 *
 * 用户自定义供应商 = 同一套 OpenAI 兼容请求/响应逻辑（与 minimax 完全一致）
 * 换 base URL 与模型名，零协议新代码；请求经本机 dev 中间件 /api/vision 转发
 * 规避浏览器 CORS（本项目是浏览器应用，与桌面应用的本质差异）。
 * 表存模块级缓存，由 settings 读写侧经 setCustomProviders 同步（先例同 setProviderRegion）。
 * ------------------------------------------------------------------ */

/** 自定义供应商表（模块级缓存） */
let customProviders: VisionProvider[] = [];

/** 同步自定义供应商表（settings 读写侧调用；每次重建 provider 对象） */
export function setCustomProviders(list: CustomProviderConfig[]): void {
  customProviders = list.map(makeCustomProvider);
}

/**
 * OpenAI 兼容模板：请求/响应结构与 minimax 实现完全一致（providers.ts:63-126），
 * 仅 base URL 与模型来自用户配置。
 * 代理封装：buildVisionRequest 返回的 url 是本机中间件 /api/vision，
 * body 为 { url, apiKey, body } 三层包——中间件负责加 Authorization 头转发，
 * 浏览器侧零 CORS、analyze 与 VisionProvider 接口零改动。MiniMax 仍直连（不动）。
 */
function makeCustomProvider(cfg: CustomProviderConfig): VisionProvider {
  return {
    id: cfg.id,
    name: cfg.name,
    // 接口要求非空；自定义供应商不走模型下拉（主界面模型行为自由输入），此值仅占位
    models: [cfg.model || "custom"],
    endpoint: () => cfg.baseUrl,
    keyHeader: "Authorization",
    keyPrefix: "Bearer ",
    buildVisionRequest(req) {
      return {
        url: "/api/vision",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`,
            apiKey: cfg.apiKey, // 供应商自带 key（一供应商一 key，用户 2026-09-26 口径）
            body: {
              model: req.model,
              messages: [
                {
                  role: "user",
                  // 静态提示词前置、图片后置（口径同 MiniMax，D5 缓存前缀）
                  content: [
                    { type: "text", text: req.prompt },
                    { type: "image_url", image_url: { url: req.imageDataUrl } },
                  ],
                },
              ],
            },
          }),
          signal: req.signal,
        },
      };
    },
    // 响应解析与 MiniMax 同款（content 容忍数组拼段；usage 容忍字段缺失）
    parseResponse(json) {
      const root = json as
        | {
            choices?: Array<{ message?: { content?: unknown } }>;
            usage?: Record<string, unknown>;
          }
        | null
        | undefined;
      if (!root || typeof root !== "object") {
        throw new Error("供应商响应结构缺失");
      }
      const content = root.choices?.[0]?.message?.content;
      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((seg) => {
            if (!seg || typeof seg !== "object") return "";
            const t = (seg as { text?: unknown }).text;
            return typeof t === "string" ? t : "";
          })
          .join("");
      } else {
        throw new Error("供应商响应缺少 choices[0].message.content");
      }
      const usage = root.usage ?? {};
      const num = (v: unknown): number => (typeof v === "number" ? v : 0);
      return {
        text,
        usage: {
          promptTokens: num(usage.prompt_tokens),
          completionTokens: num(usage.completion_tokens),
          cachedTokens: num(usage.cached_tokens),
        },
      };
    },
  };
}

/** 生成自定义供应商 id（口径对齐 binding.randomLibraryId 的随机段） */
export function newCustomProviderId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `custom-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** 按 id 取 provider：先内置（MiniMax/fake），再自定义；未知 id 回退 minimax */
export function getProvider(id: string): VisionProvider {
  return (
    PROVIDERS.find((p) => p.id === id) ??
    customProviders.find((p) => p.id === id) ??
    minimax
  );
}
