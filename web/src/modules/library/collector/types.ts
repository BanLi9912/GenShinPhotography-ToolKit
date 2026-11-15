/**
 * M3 浏览器拖拽采集 · 采集协议（工具箱侧与扩展侧共用的唯一真值）。
 *
 * 扩展侧是经典脚本（`web/extensions/collector/*.js`），不能 import 本文件，
 * 常量与字段名在那边是手写的副本；`web/scripts/build-collector.mjs` 会在每次
 * `npm run build` 前核对命名空间与版本号，副本漂移会直接让构建失败。
 *
 * 传输层事实（2026-11-12 调研）：Chrome 扩展消息使用 JSON 序列化，Blob/File/
 * 目录句柄都过不去，所以图片只有 base64 分块一条路；工具箱侧不能把 Blob 或
 * 整段巨型 base64 塞进一条消息。
 */

/** 协议命名空间：所有消息（含 postMessage 与 runtime 消息）都带这个标识 */
export const PROTOCOL_NS = "ystk-collector";

/** 协议版本：字段语义不兼容时递增；未知版本一律不执行副作用 */
export const PROTOCOL_VERSION = 1;

/** 允许接收采集的工具箱页面来源（扩展侧 content script 同样只在这两个源上启用） */
export const TOOLKIT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/** 单张图片字节上限（收发两端各自独立执行） */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** 单个分块解码后的上限（base64 文本约 341 KiB） */
export const MAX_CHUNK_BYTES = 256 * 1024;

/** 单层目录枚举最多返回的子目录条数 */
export const MAX_CHILD_DIRS = 500;

/** 单层目录枚举的时间预算 */
export const LIST_BUDGET_MS = 3000;

/** 单次保存从 BEGIN 到 COMMIT 完成的总预算（扩展侧计时，工具箱侧同口径兜底） */
export const SAVE_BUDGET_MS = 60_000;

/** 扩展后台抓图的网络超时 */
export const FETCH_TIMEOUT_MS = 20_000;

/** 分块确认超时 */
export const CHUNK_ACK_TIMEOUT_MS = 5_000;

/** 目录 / 普通消息超时（扩展侧等待工具箱应答） */
export const MESSAGE_TIMEOUT_MS = 3_000;

/** 终态结果留存：条数与时长（幂等回执用，不持久化） */
export const TERMINAL_KEEP = 100;
export const TERMINAL_TTL_MS = 10 * 60_000;

/** 逻辑消息类型（请求）；回复统一走 CollectorResponse，不再另设类型 */
export type CollectorType =
  | "HELLO"
  | "GET_TARGET"
  | "LIST_CHILDREN"
  | "BEGIN_SAVE"
  | "FILE_CHUNK"
  | "COMMIT_SAVE"
  | "GET_RESULT"
  | "CANCEL_SAVE";

/** 工具箱主动推给扩展的事件类型（不属于请求/回复，故单列） */
export type CollectorEventType = "TARGET_CHANGED";

/**
 * 错误码：扩展侧按码给出文案，工具箱不再解释人话（两边文案口径见
 * `web/extensions/collector/README.md` §4）。新增码时两边同步。
 */
export type CollectorErrorCode =
  | "BAD_VERSION"
  | "BAD_REQUEST"
  | "NOT_LIBRARY_PAGE"
  | "NO_LIBRARY"
  | "NOT_READY"
  | "PERMISSION_LOST"
  | "CROSS_SEARCH"
  | "STALE_TARGET"
  | "OUT_OF_SCOPE"
  | "DIR_MISSING"
  | "BUSY"
  | "UNKNOWN_SAVE"
  | "CHUNK_OUT_OF_ORDER"
  | "TOO_LARGE"
  | "INVALID_IMAGE"
  | "SIZE_MISMATCH"
  | "WRITE_FAILED"
  | "TIMEOUT"
  | "INTERNAL";

export interface CollectorError {
  code: CollectorErrorCode;
  message: string;
}

/** 请求信封：`instanceId` 只在工具箱作为收件方时出现（扩展发出的请求都填） */
export interface CollectorRequest<P = unknown> {
  ns: typeof PROTOCOL_NS;
  v: number;
  kind: "request";
  type: CollectorType;
  requestId: string;
  instanceId?: string;
  payload: P;
}

/**
 * 回复信封：`ok` 为真时 `data` 必有；为假时 `error` 必有。
 * 幂等要求：同一 requestId 重复到达必须返回同一份 data（见 receiver.ts 的终态表）。
 */
export interface CollectorResponse<D = unknown> {
  ns: typeof PROTOCOL_NS;
  v: number;
  kind: "response";
  requestId: string;
  type?: CollectorType;
  ok: boolean;
  data?: D;
  error?: CollectorError;
}

/** 工具箱 → 扩展的单向事件 */
export interface CollectorEvent<P = unknown> {
  ns: typeof PROTOCOL_NS;
  v: number;
  kind: "event";
  type: CollectorEventType;
  payload: P;
}

export type CollectorEnvelope = CollectorRequest | CollectorResponse | CollectorEvent;

/**
 * 目标快照：浮层打开时拿到的"工具箱那一刻"的浏览状态。
 * `contextVersion` 是陈旧判据——图库 / folderScope / 就绪态变化即递增，
 * 旧浮层拿旧版本提交必须被拒（STALE_TARGET），不能悄悄换目标。
 */
export interface TargetSnapshot {
  /** 工具箱页面实例 id：每次刷新随机生成，用于区分"同一地址的不同页面生命周期" */
  instanceId: string;
  libraryId: string;
  libraryName: string;
  /** 图库相对基目录（folderScope ?? ""），空串 = 图库根 */
  baseRelPath: string;
  contextVersion: number;
  /** phase === "ready" */
  ready: boolean;
  /** 目录权限是否 granted（只查询，不请求——授权必须由用户手势触发） */
  permission: boolean;
  theme: "light" | "dark";
}

/** GET_TARGET 的结果：`target` 可能非空但 `blocked` 有值（例如权限失效、跨库搜索） */
export interface GetTargetResult {
  target: TargetSnapshot | null;
  blocked: CollectorError | null;
  /** 跨库搜索开关（开启时拒绝新采集） */
  crossLibrary: boolean;
}

/** HELLO 的结果：popup 用它显示"工具箱在看哪个图库 / 目录" */
export interface HelloResult {
  instanceId: string;
  libraryName: string | null;
  baseRelPath: string;
  /** 展示用路径：图库名 + 相对路径（不是磁盘绝对路径——FSA 拿不到） */
  displayPath: string;
  theme: "light" | "dark";
  ready: boolean;
}

export interface DirEntry {
  name: string;
  /** 图库相对路径（`/` 分段，不含首尾斜杠） */
  relPath: string;
}

export interface ListChildrenPayload {
  target: Pick<TargetSnapshot, "instanceId" | "contextVersion">;
  /** 要枚举的图库相对路径（必须在基目录范围内） */
  relPath: string;
}

export interface ListChildrenResult {
  relPath: string;
  entries: DirEntry[];
  /** 触顶 / 超时 → true；此时列表不完整，UI 必须明说 */
  truncated: boolean;
  truncatedReason: "limit" | "timeout" | null;
}

export interface SaveSourceInfo {
  /** http(s) 还是 data:（扩展侧在 BEGIN 时声明来源种类，工具箱只用于提示文案） */
  urlKind: "http" | "data";
  pageUrl: string;
  pageTitle: string;
  /** 图片 alt 文本（可空） */
  alt: string;
}

export interface BeginSavePayload {
  target: Pick<TargetSnapshot, "instanceId" | "contextVersion">;
  /** 目标目录（图库相对路径，必须在基目录范围内；空串 = 图库根） */
  relPath: string;
  source: SaveSourceInfo;
}

export interface BeginSaveResult {
  saveId: string;
}

export interface FileChunkPayload {
  saveId: string;
  /** 从 0 开始，必须严格连续 */
  index: number;
  /** base64（解码后 ≤ MAX_CHUNK_BYTES） */
  data: string;
}

export interface FileChunkResult {
  nextIndex: number;
  bytes: number;
}

export interface CommitSavePayload {
  saveId: string;
  /** 扩展侧统计的总字节数，工具箱必须核对 */
  totalBytes: number;
  /** 建议文件名主干（工具箱会清洗并补随机后缀） */
  stem: string;
}

export interface SaveResult {
  fileName: string;
  /** 文件在图库内的相对路径（含文件名） */
  relPath: string;
  bytes: number;
}

export interface GetResultPayload {
  saveId?: string;
  /** 提交时用的 requestId（COMMIT 回执丢失时的兜底查询入口） */
  requestId?: string;
}

export type SaveStatus = "pending" | "done" | "failed" | "unknown";

export interface GetResultResult {
  status: SaveStatus;
  result?: SaveResult;
  error?: CollectorError;
}

export interface CancelSavePayload {
  saveId: string;
}

export interface CancelSaveResult {
  cancelled: boolean;
}
