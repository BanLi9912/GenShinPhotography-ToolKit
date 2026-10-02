/**
 * M3.4.5 向量轨 · Ollama 客户端（正式落地，逻辑移植自 .tools/shots/m34vector-poc.mjs
 * checkEnv / embed，调整为浏览器模块函数）。
 *
 * - checkOllama：不抛错，返回状态对象（指示灯三态要用）；模型缺失只报告 ok:false，
 *   不做自动 ollama pull（浏览器无 CLI，由 UI 提示用户手工拉取）。
 * - embedTexts：批量嵌入 + L2 归一化（归一化只在这里做一次，后续余弦 = 直接点积）；
 *   120s 超时（首次含模型加载）、失败重试 1 次、仍失败上抛（调用方按批跳过）。
 * - 只直连本机 endpoint（默认 http://localhost:11434），禁止访问任何非 endpoint 地址。
 */

/** Ollama 自检结果（R2；错误信息面向用户展示，纯中文） */
export interface OllamaCheck {
  ok: boolean;
  modelName?: string;
  dims?: number;
  error?: string;
}

const HTTP_TIMEOUT_MS = 120_000; // 嵌入请求超时（≥120s，首次调用含模型加载）
const TAGS_TIMEOUT_MS = 8_000; // /api/tags 轻量探测超时

/** 按模型名前缀匹配（名字可能带 :latest 后缀） */
function modelInTags(tagsJson: { models?: Array<{ name?: string }> }, model: string): string | null {
  const models = Array.isArray(tagsJson.models) ? tagsJson.models : [];
  for (const m of models) {
    const name = String(m.name ?? "");
    if (name === model || name.startsWith(`${model}:`) || name.startsWith(`${model}-`)) {
      return name;
    }
  }
  return null;
}

/**
 * 自检：GET /api/tags 看 Ollama 在跑且模型已拉取。
 * 网络失败 / HTTP 非 2xx / JSON 坏 → ok:false + error；模型缺失 → ok:false + error。
 * 永不抛错（指示灯轮询 30s 一次，不许因一次抖动崩 UI）。
 */
export async function checkOllama(endpoint: string, model: string): Promise<OllamaCheck> {
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `Ollama 返回 HTTP ${res.status}（${endpoint}）` };
    }
    const json: unknown = await res.json();
    const hit = modelInTags(json as { models?: Array<{ name?: string }> }, model);
    if (!hit) {
      return {
        ok: false,
        error: `模型 ${model} 未拉取。请在 Ollama 中执行：ollama pull ${model}`,
      };
    }
    return { ok: true, modelName: hit };
  } catch (err) {
    return {
      ok: false,
      error: `无法连接 Ollama（${endpoint}）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 批量嵌入。POST /api/embed，body {model, input:[...]} → {embeddings:[[...],...]}。
 * 返回 L2 归一化后的 Float32Array[]（点积即余弦）。失败重试 1 次后仍失败上抛。
 */
export async function embedTexts(
  endpoint: string,
  model: string,
  texts: string[],
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as { embeddings?: unknown };
      const embs = json.embeddings;
      if (!Array.isArray(embs) || embs.length !== texts.length) {
        throw new Error(`返回 ${Array.isArray(embs) ? embs.length : "非数组"} 条嵌入，与输入 ${texts.length} 条不符`);
      }
      return embs.map((raw) => {
        if (!Array.isArray(raw)) throw new Error("嵌入向量非数组");
        const vec = Float32Array.from(raw as number[]);
        return l2Normalize(vec);
      });
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        // 重试一次（网络抖动 / 服务瞬断）
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** L2 归一化（零向量兜底置零，点积自然为 0） */
function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / norm;
  return out;
}
