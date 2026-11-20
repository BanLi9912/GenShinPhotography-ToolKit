/**
 * M3 浏览器拖拽采集 · 页面 ↔ 扩展 content script 的消息桥。
 *
 * 通路（任务卡 §4.3）：
 *   普通网页 content.js → 扩展后台 → 工具箱专用 content script（toolkit-bridge.js）
 *   → `window.postMessage` → 本文件；回程原路返回。
 *
 * 本文件只做三件事：校验信封、按 type 转发给 receiver、把回复按同一 requestId 送回。
 * 监听安装/卸载严格对称（React StrictMode 会挂载→卸载→再挂载，重复处理会让一次
 * BEGIN_SAVE 建出两个会话），故用引用计数 + 单例安装。
 */
import {
  PROTOCOL_NS,
  PROTOCOL_VERSION,
  type BeginSavePayload,
  type CancelSavePayload,
  type CollectorEnvelope,
  type CollectorError,
  type CollectorRequest,
  type CollectorResponse,
  type CommitSavePayload,
  type FileChunkPayload,
  type GetResultPayload,
  type ListChildrenPayload,
} from "./types";
import {
  INSTANCE_ID,
  beginSave,
  bumpIfContextChanged,
  cancelSave,
  commit,
  currentContextVersion,
  fileChunk,
  getResult,
  hello,
  listChildren,
  peekTerminal,
  readTarget,
  rememberRequestResult,
} from "./receiver";
import { useLibraryStore } from "../store";

/** 页面侧发送标记：content script 只认这个键，避免与网页自己的 postMessage 撞车 */
const INBOUND_MARK = "toolkit-in";
const OUTBOUND_MARK = "toolkit-out";

/** 已处理的请求（幂等）：同一 requestId 重复到达直接回放原响应 */
const answered = new Map<string, { at: number; response: CollectorResponse }>();
const ANSWER_KEEP_MS = 10 * 60_000;
const ANSWER_KEEP_COUNT = 100;

let refCount = 0;
let uninstall: (() => void) | null = null;

/**
 * 挂载采集桥（App 的 effect 调用）。
 * 返回清理函数；多次调用只装一份监听，全部清理完才真正卸载。
 */
export function startCollectorBridge(): () => void {
  refCount += 1;
  if (!uninstall) uninstall = install();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    refCount -= 1;
    if (refCount <= 0) {
      refCount = 0;
      const stop = uninstall;
      uninstall = null;
      stop?.();
    }
  };
}

function install(): () => void {
  const onMessage = (event: MessageEvent) => {
    // 只接受同窗口、同源的消息；页面上任何第三方脚本都无法伪造扩展身份
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data as { __ystk?: unknown; envelope?: unknown } | null;
    if (!data || typeof data !== "object" || data.__ystk !== INBOUND_MARK) return;
    const envelope = data.envelope as CollectorEnvelope | undefined;
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.kind !== "request") return; // 页面收请求没有意义：只处理请求/忽略事件
    void handleRequest(envelope as CollectorRequest).then((response) => {
      postToExtension(response);
    });
  };
  window.addEventListener("message", onMessage);

  // 目标变化即作废旧浮层：扩展收到事件后把浮层切到"目标已变，请重新拖动"
  const unsubscribe = useLibraryStore.subscribe(() => {
    if (bumpIfContextChanged()) broadcastTargetChanged();
  });

  return () => {
    window.removeEventListener("message", onMessage);
    unsubscribe();
  };
}

function postToExtension(envelope: CollectorEnvelope): void {
  // 精确 targetOrigin：不用 "*"，避免信封被同页不可信脚本读取后伪造请求
  window.postMessage({ __ystk: OUTBOUND_MARK, envelope }, window.location.origin);
}

function broadcastTargetChanged(): void {
  postToExtension({
    ns: PROTOCOL_NS,
    v: PROTOCOL_VERSION,
    kind: "event",
    type: "TARGET_CHANGED",
    payload: { contextVersion: currentContextVersion() },
  });
}

function envelopeError(
  requestId: string,
  type: CollectorResponse["type"],
  code: CollectorError["code"],
  message: string,
): CollectorResponse {
  return {
    ns: PROTOCOL_NS,
    v: PROTOCOL_VERSION,
    kind: "response",
    requestId,
    type,
    ok: false,
    error: { code, message },
  };
}

function pruneAnswered(): void {
  const now = Date.now();
  for (const [key, entry] of answered) {
    if (now - entry.at > ANSWER_KEEP_MS) answered.delete(key);
  }
  while (answered.size > ANSWER_KEEP_COUNT) {
    const oldest = answered.keys().next();
    if (oldest.done) break;
    answered.delete(oldest.value);
  }
}

/**
 * 在途请求（requestId → Promise）：扩展侧的桥每 500ms 重发同一封信封，
 * 只记"已完成的答复"挡不住在途重放——BEGIN_SAVE 会被跑两遍（第二个会话覆盖
 * 第一个，后续分块全被判 UNKNOWN_SAVE）。这里让重复请求直接等同一份结果。
 */
const inflight = new Map<string, Promise<CollectorResponse>>();

async function handleRequest(request: CollectorRequest): Promise<CollectorResponse> {
  const requestId = typeof request.requestId === "string" ? request.requestId : "";
  if (!requestId) return runRequest(request); // 缺 requestId 无从去重：交给原逻辑回 BAD_REQUEST
  const running = inflight.get(requestId);
  if (running) return running;
  const run = runRequest(request);
  inflight.set(requestId, run);
  const settle = () => inflight.delete(requestId);
  void run.then(settle, settle);
  return run;
}

async function runRequest(request: CollectorRequest): Promise<CollectorResponse> {
  // 版本/命名空间不符：不执行任何副作用，只回一个明确的错误
  if (request.ns !== PROTOCOL_NS || request.v !== PROTOCOL_VERSION) {
    return envelopeError(
      String(request.requestId ?? ""),
      request.type,
      "BAD_VERSION",
      `协议版本不匹配（收到 v${String(request.v)}，需要 v${PROTOCOL_VERSION}）`,
    );
  }
  const requestId = typeof request.requestId === "string" ? request.requestId : "";
  if (!requestId) {
    return envelopeError("", request.type, "BAD_REQUEST", "缺少 requestId");
  }

  const replay = answered.get(requestId);
  if (replay) return replay.response;

  // COMMIT 的幂等还有一层 saveId 级兜底：重复请求换了 requestId 也返回原结果
  if (request.type === "COMMIT_SAVE") {
    const done = peekTerminal(String((request.payload as CommitSavePayload)?.saveId ?? ""));
    if (done) {
      const response: CollectorResponse = done.result
        ? {
            ns: PROTOCOL_NS,
            v: PROTOCOL_VERSION,
            kind: "response",
            requestId,
            type: request.type,
            ok: true,
            data: done.result,
          }
        : envelopeError(requestId, request.type, done.error?.code ?? "WRITE_FAILED", done.error?.message ?? "保存失败");
      return remember(response);
    }
  }

  const payload = (request.payload ?? {}) as Record<string, unknown>;
  let response: CollectorResponse;
  switch (request.type) {
    case "HELLO":
      response = ok(requestId, request.type, hello());
      break;
    case "GET_TARGET":
      response = ok(requestId, request.type, await readTarget());
      break;
    case "LIST_CHILDREN": {
      const result = await listChildren(payload as unknown as ListChildrenPayload);
      response = result.ok
        ? ok(requestId, request.type, result.data)
        : envelopeError(requestId, request.type, result.error.code, result.error.message);
      break;
    }
    case "BEGIN_SAVE": {
      const result = await beginSave(payload as unknown as BeginSavePayload);
      response = result.ok
        ? ok(requestId, request.type, result.data)
        : envelopeError(requestId, request.type, result.error.code, result.error.message);
      break;
    }
    case "FILE_CHUNK": {
      const result = fileChunk(payload as unknown as FileChunkPayload);
      response = result.ok
        ? ok(requestId, request.type, result.data)
        : envelopeError(requestId, request.type, result.error.code, result.error.message);
      break;
    }
    case "COMMIT_SAVE": {
      const result = await commit(payload as unknown as CommitSavePayload);
      response = result.ok
        ? ok(requestId, request.type, result.data)
        : envelopeError(requestId, request.type, result.error.code, result.error.message);
      rememberRequestResult(requestId, result.ok ? { result: result.data } : { error: result.error });
      break;
    }
    case "GET_RESULT": {
      const result = getResult(payload as unknown as GetResultPayload);
      response = result.ok
        ? ok(requestId, request.type, result.data)
        : envelopeError(requestId, request.type, result.error.code, result.error.message);
      break;
    }
    case "CANCEL_SAVE": {
      const data = cancelSave(payload as unknown as CancelSavePayload);
      response = ok(requestId, request.type, data);
      break;
    }
    default:
      // 未知类型：不回副作用，只报错（协议向前兼容时的安全出口）
      response = envelopeError(requestId, request.type, "BAD_REQUEST", "未知的消息类型");
      break;
  }
  return remember(response);
}

function ok(requestId: string, type: CollectorResponse["type"], data: unknown): CollectorResponse {
  return {
    ns: PROTOCOL_NS,
    v: PROTOCOL_VERSION,
    kind: "response",
    requestId,
    type,
    ok: true,
    data,
  };
}

function remember(response: CollectorResponse): CollectorResponse {
  answered.set(response.requestId, { at: Date.now(), response });
  pruneAnswered();
  return response;
}

/** 当前工具箱实例 id（popup/日志用；测试脚本也可以据此构造信封） */
export const collectorInstanceId = INSTANCE_ID;
