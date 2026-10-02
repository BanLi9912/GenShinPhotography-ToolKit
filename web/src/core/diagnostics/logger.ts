/**
 * 开发者日志内核（2026-09-24 任务卡「开发者日志监控」v2）。
 * 设计约束：关闭时零开销（不装监听、不劫持 console）；开启后一切采集与
 * 上报逻辑自身异常一律吞掉——日志系统绝不能反过来影响主程序。
 * - 采集面：全局 error / unhandledrejection、console.error / console.warn
 *   （原样透传原实现，不改既有行为）、外部喂入的状态摘要
 *   （store 订阅在 app/diagnostics.ts，core 不依赖 modules）
 * - 存储：内存环形缓冲（4000 条封顶，超限丢最旧 500 条）+ 每 10s 把
 *   **新增行**增量 POST 给 dev server（/api/devlog），由 Node 追加写到
 *   仓库根 devdata/logs/session-<时间戳>.jsonl（浏览器无权直写仓库根，
 *   经中间件零选择零授权——用户 2026-09-24 口径）
 * - **会话与 dev server 启停绑定**（2026-09-24 用户口径）：文件名由 dev server
 *   启动时间决定（问 GET /api/devlog/session 取得），**一个 dev server 生命周期
 *   = 一个 JSONL 文件**；浏览器刷新/重开开关都续写同一文件，不产生新文件。
 *   dev server 重启 → 新文件名 → 新文件。
 * - dev server 不可达（vite preview / 静态站）：自动降级仅内存，状态可见
 * - 页面隐藏/卸载兜底：小批量走 sendBeacon，大批量赌普通 fetch（尽力而为）
 */

export type DevLogLevel = "meta" | "info" | "state" | "warn" | "error";

export interface DevLogEntry {
  /** epoch ms */
  t: number;
  lvl: DevLogLevel;
  /** 来源：meta / window / promise / console / route / visibility / store:<名> / devlog */
  src: string;
  msg: string;
  /** 已消毒截断的补充信息（字符串，可为 JSON） */
  detail?: string;
}

export interface DevLogStatus {
  started: boolean;
  /** 内存缓冲总条数 */
  buffered: number;
  /** 尚未成功上报的条数 */
  pending: number;
  /** 会话文件名（session-*.jsonl）；null = 未开启 */
  file: string | null;
  lastFlushAt: number | null;
  /** 最近一次上报是否失败（true = dev server 不可达，仅内存） */
  sinkError: boolean;
}

/** 环形缓冲上限与超限单次丢弃量（批量丢，避免每条一次 splice） */
const RING_MAX = 4000;
const RING_DROP = 500;
/** 周期上报间隔（ms） */
const FLUSH_MS = 10_000;
/** msg / detail 截断长度 */
const MSG_CAP = 300;
const DETAIL_CAP = 1500;
/** sendBeacon 单次负载上限（浏览器实现普遍 64KB，留余量） */
const BEACON_CAP = 60_000;

const ENDPOINT = "/api/devlog";
/** 取当前 dev server 会话文件名（实现"日志与 dev server 启停绑定"） */
const SESSION_ENDPOINT = "/api/devlog/session";

let started = false;
let entries: DevLogEntry[] = [];
/** 已成功上报到的下标（sentUpto 之前的行都已写盘） */
let sentUpto = 0;
let sessionFile: string | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushChain: Promise<void> = Promise.resolve();
let lastFlushAt: number | null = null;
let sinkError = false;
let inCapture = false;
const lastSummary = new Map<string, string>();
let lastRoute: string | null = null;

/** 原始 console 引用（劫持前留存；透传与内部逻辑都用它，防自反馈） */
let origError: Console["error"] | null = null;
let origWarn: Console["warn"] | null = null;

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 任意值 → 安全字符串：Error 展开（含前 3 行栈）、对象尝试 JSON、失败回退 String */
function safeString(value: unknown): string {
  if (value instanceof Error) {
    const stack = value.stack
      ? ` @ ${value.stack.split("\n").slice(0, 3).join(" | ")}`
      : "";
    return `${value.name}: ${value.message}${stack}`;
  }
  if (typeof value === "string") return value;
  if (value == null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** console 多参 → detail：逐个消毒后拼接，整体截断 */
function argsToDetail(args: unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  return cap(args.map(safeString).join(" "), DETAIL_CAP);
}

/** 记一条（内部直达，不做开关判断——关闭沿的收尾条目也要能记录） */
function push(lvl: DevLogLevel, src: string, msg: string, detail?: string): void {
  entries.push({ t: Date.now(), lvl, src, msg: cap(msg, MSG_CAP), detail });
  if (entries.length > RING_MAX) {
    entries.splice(0, RING_DROP);
    sentUpto = Math.max(0, sentUpto - RING_DROP);
  }
}

/** 外部记录入口：未开启时静默丢弃（关闭 = 零开销承诺的一部分） */
export function devLog(lvl: DevLogLevel, src: string, msg: string, detail?: string): void {
  if (!started) return;
  push(lvl, src, msg, detail);
}

/** 状态摘要：同一 store 摘要串未变化时不记（防扫描/识图逐条进度刷屏） */
export function devLogState(store: string, summary: Record<string, unknown>): void {
  if (!started) return;
  let text: string;
  try {
    text = JSON.stringify(summary);
  } catch {
    text = "{}";
  }
  if (lastSummary.get(store) === text) return;
  lastSummary.set(store, text);
  push("state", `store:${store}`, text);
}

/** 路由切换（内部去重：同一路径不重复记，StrictMode 双跑天然无害） */
export function devLogRoute(pathname: string): void {
  if (!started || pathname === lastRoute) return;
  lastRoute = pathname;
  push("info", "route", pathname);
}

export function devLogStatus(): DevLogStatus {
  return {
    started,
    buffered: entries.length,
    pending: Math.max(0, entries.length - sentUpto),
    file: sessionFile,
    lastFlushAt,
    sinkError,
  };
}

/* ---- console 劫持：仅 error/warn，log/info/debug 一律不碰 ---- */

function patchConsole(): void {
  origError = console.error;
  origWarn = console.warn;
  console.error = ((...args: unknown[]) => {
    if (!inCapture) {
      inCapture = true;
      try {
        push("error", "console", safeString(args[0]), argsToDetail(args.slice(1)));
      } finally {
        inCapture = false;
      }
    }
    origError?.(...args);
  }) as Console["error"];
  console.warn = ((...args: unknown[]) => {
    if (!inCapture) {
      inCapture = true;
      try {
        push("warn", "console", safeString(args[0]), argsToDetail(args.slice(1)));
      } finally {
        inCapture = false;
      }
    }
    origWarn?.(...args);
  }) as Console["warn"];
}

function restoreConsole(): void {
  if (origError) console.error = origError;
  if (origWarn) console.warn = origWarn;
  origError = null;
  origWarn = null;
}

/* ---- 全局异常 ---- */

function onWindowError(e: ErrorEvent): void {
  const where = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : "";
  push("error", "window", safeString(e.error ?? e.message), where || undefined);
}

function onRejection(e: PromiseRejectionEvent): void {
  push("error", "promise", safeString(e.reason));
}

/* ---- 上报 ---- */

/** 本地时间戳文件名段：YYYYMMDD-HHmmss（字典序即时间序，供保留策略排序用） */
function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 未上报行 → JSONL 文本（无新增返回 null） */
function pendingText(): string | null {
  if (sentUpto >= entries.length) return null;
  return `${entries.slice(sentUpto).map((e) => JSON.stringify(e)).join("\n")}\n`;
}

async function flushNow(): Promise<void> {
  const text = pendingText();
  if (!sessionFile || text === null) return;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: sessionFile, text }),
  });
  // 409 = dev server 已重启换会话（本页还持旧名）：改用新名重投，
  // 否则会往旧文件续写，违背"一个 server 生命周期一个文件"
  if (res.status === 409) {
    const data = (await res.json().catch(() => null)) as { session?: unknown } | null;
    if (typeof data?.session === "string" && /^session-\d{8}-\d{6}\.jsonl$/.test(data.session)) {
      sessionFile = data.session;
    }
    throw new Error("会话已更换，待下次上报重投");
  }
  if (!res.ok) throw new Error(`POST /api/devlog → ${res.status}`);
  sentUpto = entries.length;
  lastFlushAt = Date.now();
  sinkError = false;
}

/** 串行上报链（同 vector store 落盘先例）：失败只置状态位，绝不抛出 */
function scheduleFlush(): void {
  flushChain = flushChain.then(() => flushNow()).catch(() => {
    sinkError = true;
    lastFlushAt = Date.now();
  });
}

/** 手动触发一次上报（开关关闭沿用）；返回链尾供等待 */
export function devLogFlush(): Promise<void> {
  scheduleFlush();
  return flushChain;
}

/** 页面隐藏/卸载兜底：小批量 sendBeacon（不可达也不报错），大批量赌普通 fetch */
function flushUrgent(): void {
  const text = pendingText();
  if (!sessionFile || text === null) return;
  const payload = JSON.stringify({ file: sessionFile, text });
  if (payload.length <= BEACON_CAP) {
    navigator.sendBeacon(
      ENDPOINT,
      new Blob([payload], { type: "application/json" }),
    );
    sentUpto = entries.length;
  } else {
    void devLogFlush();
  }
}

/* ---- 启停 ---- */

function onVisibility(): void {
  if (document.visibilityState === "hidden") flushUrgent();
}

/**
 * 会话文件名由 **dev server 启动时间** 决定（2026-09-24 用户口径：日志与
 * dev server 启停绑定）——所以本函数只向服务端问名字，不自己造。
 * 服务端不可达（vite preview / 静态站）时退回本地时间戳命名：此时 POST 必然
 * 也失败，状态位会显示"开发服务器未运行"，文件名只是本地占位，不产生磁盘文件。
 */
async function resolveSessionFile(): Promise<string> {
  try {
    const res = await fetch(SESSION_ENDPOINT);
    if (res.ok) {
      const data = (await res.json()) as { session?: unknown };
      if (typeof data.session === "string" && /^session-\d{8}-\d{6}\.jsonl$/.test(data.session)) {
        return data.session;
      }
    }
  } catch {
    /* 服务端不可达 → 走下面的本地占位名 */
  }
  return `session-${localStamp()}.jsonl`;
}

export function devLogStart(): void {
  if (started) return;
  started = true;
  // 新会话：清缓冲与去重表（上一次会话已在关闭沿上报完）
  entries = [];
  sentUpto = 0;
  lastSummary.clear();
  lastRoute = null;
  patchConsole();
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onVisibility);
  flushTimer = setInterval(() => scheduleFlush(), FLUSH_MS);
  // 定名是异步的（要问 dev server）；期间条目照常入缓冲，flushNow 见
  // sessionFile 为 null 会跳过，定名完成后统一上报——不丢条目，只晚一拍
  void (async () => {
    sessionFile = await resolveSessionFile();
    scheduleFlush(); // 立即首刷：写入会话首行 + 尽早暴露 dev server 可达性
  })();
}

export async function devLogStop(): Promise<void> {
  if (!started) return;
  started = false;
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  window.removeEventListener("error", onWindowError);
  window.removeEventListener("unhandledrejection", onRejection);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pagehide", onVisibility);
  restoreConsole();
  push("info", "devlog", "开发者日志已关闭");
  await devLogFlush();
}
