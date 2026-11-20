/**
 * M3 浏览器拖拽采集 · 接收端（工具箱页面侧）。
 *
 * 职责边界（任务卡 §4.3/§4.4）：
 * - 只回答"目标是谁、这一层有哪些子目录、这张图往哪写"；
 * - 只落盘：不调 `rescan` / `finishScan` / `upsertItem`，不写 `.ystk`，不动
 *   `current.itemCount` / `items`，不触发分析/识图/向量队列——用户之后手动
 *   「重新扫描」才入库；
 * - 所有路径逐段校验并用数组比较判定归属（裸 startsWith 会把 `a` 当成 `ab` 的祖先）；
 * - 目录查找一律 create:false：目标被删就报错，绝不自动重建，也绝不回退到根目录。
 *
 * 状态全部在内存：刷新即换 instanceId（bridge 持有），终态表最多 100 条 / 10 分钟。
 */
import {
  MAX_CHILD_DIRS,
  MAX_CHUNK_BYTES,
  MAX_IMAGE_BYTES,
  LIST_BUDGET_MS,
  TERMINAL_KEEP,
  TERMINAL_TTL_MS,
  type BeginSavePayload,
  type BeginSaveResult,
  type CancelSaveResult,
  type CollectorError,
  type CollectorErrorCode,
  type CommitSavePayload,
  type DirEntry,
  type FileChunkPayload,
  type FileChunkResult,
  type GetResultPayload,
  type GetResultResult,
  type GetTargetResult,
  type HelloResult,
  type ListChildrenPayload,
  type ListChildrenResult,
  type SaveResult,
  type TargetSnapshot,
} from "./types";
import { ensureEntryPermission, getEntry } from "../index/binding";
import { useLibraryStore } from "../store";
import { useThemeStore } from "../../../app/theme";

/** 工具箱页面实例 id：每次刷新换一个，扩展据此判断"还是不是同一个页面" */
export const INSTANCE_ID = randomHex(16, "yi_");

/** 浮层/目录导航用的自然排序（中文语境按拼音、数字按数值） */
const NAME_COLLATOR = new Intl.Collator("zh-Hans-CN", {
  numeric: true,
  sensitivity: "base",
});

/** Windows 保留设备名：作为文件名主干时会被系统拒写，前置下划线绕开 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Windows 文件名禁用字符 + 控制字符（\p{Cc} 比裸控制码正则更可读，也过 lint） */
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\p{Cc}]/gu;

/** 文件名主干长度上限（码点，够放中文标题又不会撞 Windows 路径限制） */
const MAX_STEM_CHARS = 40;

/* ------------------------------------------------------------------ *
 * 上下文版本
 *
 * `contextVersion` 是"目标是否还是同一个目标"的唯一判据：图库、folderScope、
 * 就绪态（phase/权限）任一变化即递增。bridge 订阅 store 触发同步；每个请求
 * 进来也会先同步一次（订阅漏挂时不至于接受陈旧快照）。
 * ------------------------------------------------------------------ */

let contextVersion = 1;
let lastContextSignature = "";

/** 参与陈旧判定的状态签名（不含 items/count——它们不影响"写到哪"） */
function contextSignature(): string {
  const state = useLibraryStore.getState();
  return [
    state.current?.libraryId ?? "",
    state.folderScope ?? "",
    state.phase,
    state.crossLibrary ? "cross" : "single",
  ].join("\u0001");
}

/** 把当前状态同步进版本号：签名变了就递增，返回当前版本 */
export function syncContextVersion(): number {
  const signature = contextSignature();
  if (signature !== lastContextSignature) {
    lastContextSignature = signature;
    contextVersion += 1;
  }
  return contextVersion;
}

export function currentContextVersion(): number {
  return contextVersion;
}

/* ------------------------------------------------------------------ *
 * 路径校验
 * ------------------------------------------------------------------ */

/**
 * 把图库相对路径切成段；任何非法段返回 null。
 * 拒绝：绝对路径、盘符、反斜杠、`.`/`..`、空段、控制字符、任何 `.ystk` 段（大小写不敏感）。
 */
export function splitRelPath(relPath: string): string[] | null {
  if (typeof relPath !== "string") return null;
  if (relPath === "") return [];
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return null;
  if (/^[A-Za-z]:/.test(relPath)) return null;
  if (relPath.includes("\\")) return null;
  const parts = relPath.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    // eslint 风格的控制字符判定：码点 < 0x20 或 0x7f
    for (const ch of part) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return null;
    }
    if (part.toLowerCase() === ".ystk") return null;
  }
  return parts;
}

/** 数组段比较判归属：`a` 不是 `ab` 的祖先（裸 startsWith 会误判） */
export function isWithinBase(baseParts: string[], targetParts: string[]): boolean {
  if (targetParts.length < baseParts.length) return false;
  for (let i = 0; i < baseParts.length; i += 1) {
    if (targetParts[i] !== baseParts[i]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 目标快照
 * ------------------------------------------------------------------ */

/** 工具箱当前是否停在图库路由上（桥接挂在 App 上，所有路由都会加载它） */
function onLibraryRoute(): boolean {
  const path = window.location.pathname.replace(/\/+$/, "");
  return path === "/library";
}

/** 当前基目录（folderScope ?? ""） */
function currentBaseRelPath(): string {
  return useLibraryStore.getState().folderScope ?? "";
}

function displayPathOf(libraryName: string | null, relPath: string): string {
  const name = libraryName ? `/${libraryName}` : "/";
  return relPath ? `${name}/${relPath}` : name;
}

/**
 * 读当前目标快照 + 阻断原因。
 * 目标不可写时仍回 target（popup 要显示"在看哪个图库/目录"），`blocked` 说明原因。
 */
export async function readTarget(): Promise<GetTargetResult> {
  const version = syncContextVersion();
  const state = useLibraryStore.getState();
  const theme = useThemeStore.getState().theme;
  const baseRelPath = state.folderScope ?? "";
  const blockedOf = (
    code: CollectorErrorCode,
    message: string,
  ): CollectorError => ({ code, message });

  if (!onLibraryRoute()) {
    return {
      target: null,
      blocked: blockedOf("NOT_LIBRARY_PAGE", "工具箱当前不在图库页面"),
      crossLibrary: state.crossLibrary,
    };
  }
  const current = state.current;
  if (!current) {
    return {
      target: null,
      blocked: blockedOf("NO_LIBRARY", "工具箱还没有打开图库"),
      crossLibrary: state.crossLibrary,
    };
  }
  const entry = getEntry(current.libraryId);
  if (!entry) {
    return {
      target: null,
      blocked: blockedOf("NO_LIBRARY", "图库未完成绑定"),
      crossLibrary: state.crossLibrary,
    };
  }
  // 只查询不请求：异步消息不是用户手势，requestPermission 会直接失败
  const permission = await ensureEntryPermission(entry, false);
  const ready = state.phase === "ready" && permission;
  const target: TargetSnapshot = {
    instanceId: INSTANCE_ID,
    libraryId: current.libraryId,
    libraryName: current.name,
    baseRelPath,
    contextVersion: version,
    ready,
    permission,
    theme,
  };
  let blocked: CollectorError | null = null;
  if (!permission) {
    blocked = blockedOf("PERMISSION_LOST", "图库目录权限失效，请回工具箱重新授权");
  } else if (state.phase !== "ready") {
    blocked = blockedOf("NOT_READY", `工具箱正在${phaseText(state.phase)}，稍后再试`);
  } else if (state.crossLibrary) {
    blocked = blockedOf("CROSS_SEARCH", "工具箱开着跨库搜索，请先回到单一图库");
  }
  return { target, blocked, crossLibrary: state.crossLibrary };
}

function phaseText(phase: string): string {
  switch (phase) {
    case "scanning":
      return "扫描图库";
    case "binding":
      return "绑定目录";
    case "need-permission":
      return "等待目录授权";
    case "missing":
      return "重新定位目录";
    case "unbound":
      return "准备绑定图库";
    default:
      return "加载图库";
  }
}

/** HELLO：popup 用它显示接收端信息（不要求就绪，弹窗要能说明"为什么不能收") */
export function hello(): HelloResult {
  syncContextVersion();
  const state = useLibraryStore.getState();
  return {
    instanceId: INSTANCE_ID,
    libraryName: state.current?.name ?? null,
    baseRelPath: state.folderScope ?? "",
    displayPath: displayPathOf(state.current?.name ?? null, state.folderScope ?? ""),
    theme: useThemeStore.getState().theme,
    ready: state.phase === "ready",
  };
}

/** 让版本号跟上一次变化（bridge 订阅 store 时调用），并返回是否真的变了 */
export function bumpIfContextChanged(): boolean {
  const before = contextVersion;
  syncContextVersion();
  return contextVersion !== before;
}

/* ------------------------------------------------------------------ *
 * 目录枚举
 * ------------------------------------------------------------------ */

interface ResolvedDir {
  baseParts: string[];
  /** 目标目录在图库内的相对路径（规范化后的 `a/b` 形式） */
  relPath: string;
  dir: FileSystemDirectoryHandle;
}

/**
 * 校验快照新鲜度 + 路径归属，并解析出目标目录句柄（create:false）。
 * 失败一律返回错误码，绝不"大致按根目录写"。
 */
async function resolveTargetDir(
  target: { instanceId: string; contextVersion: number },
  relPath: string,
): Promise<{ ok: true; resolved: ResolvedDir } | { ok: false; error: CollectorError }> {
  if (!target || target.instanceId !== INSTANCE_ID) {
    return {
      ok: false,
      error: { code: "STALE_TARGET", message: "工具箱页面已刷新，请重新拖一次图片" },
    };
  }
  syncContextVersion();
  if (target.contextVersion !== contextVersion) {
    return {
      ok: false,
      error: { code: "STALE_TARGET", message: "工具箱的图库或目录变了，请重新拖一次图片" },
    };
  }
  const state = useLibraryStore.getState();
  if (!onLibraryRoute() || !state.current) {
    return { ok: false, error: { code: "NO_LIBRARY", message: "工具箱当前不在图库页面" } };
  }
  const parts = splitRelPath(relPath);
  if (!parts) {
    return { ok: false, error: { code: "BAD_REQUEST", message: `目录路径非法：${relPath}` } };
  }
  const baseParts = splitRelPath(currentBaseRelPath());
  if (!baseParts || !isWithinBase(baseParts, parts)) {
    return {
      ok: false,
      error: { code: "OUT_OF_SCOPE", message: "目标目录不在当前浏览目录之下" },
    };
  }
  const entry = getEntry(state.current.libraryId);
  if (!entry) {
    return { ok: false, error: { code: "NO_LIBRARY", message: "图库未完成绑定" } };
  }
  try {
    let dir = entry.handle;
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    return { ok: true, resolved: { baseParts, relPath: parts.join("/"), dir } };
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return {
        ok: false,
        error: { code: "DIR_MISSING", message: "目标子文件夹已不存在（不会自动重建）" },
      };
    }
    return {
      ok: false,
      error: { code: "INTERNAL", message: `打开目录失败：${(err as Error).message ?? err}` },
    };
  }
}

/**
 * 枚举一层子目录：只读这一层、保留空目录、排除 `.ystk`、自然排序，
 * 上限 500 条 / 3 秒——触顶或超时都标记 truncated，不假装列表完整。
 */
export async function listChildren(
  payload: ListChildrenPayload,
): Promise<{ ok: true; data: ListChildrenResult } | { ok: false; error: CollectorError }> {
  const resolved = await resolveTargetDir(payload.target, payload.relPath ?? "");
  if (!resolved.ok) return resolved;
  const { relPath, dir } = resolved.resolved;

  const entries: DirEntry[] = [];
  let truncated = false;
  let truncatedReason: "limit" | "timeout" | null = null;
  const deadline = Date.now() + LIST_BUDGET_MS;
  try {
    for await (const handle of dir.values()) {
      if (handle.kind !== "directory") continue;
      const name = handle.name;
      if (name.toLowerCase() === ".ystk") continue;
      if (entries.length >= MAX_CHILD_DIRS) {
        truncated = true;
        truncatedReason = "limit";
        break;
      }
      entries.push({ name, relPath: relPath ? `${relPath}/${name}` : name });
      if (Date.now() > deadline) {
        truncated = true;
        truncatedReason = "timeout";
        break;
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: `读取子目录失败：${(err as Error).message ?? err}` },
    };
  }
  entries.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name));
  return { ok: true, data: { relPath, entries, truncated, truncatedReason } };
}

/* ------------------------------------------------------------------ *
 * 保存会话
 * ------------------------------------------------------------------ */

interface SaveSession {
  saveId: string;
  instanceId: string;
  /** 目标目录（图库相对路径） */
  relPath: string;
  dir: FileSystemDirectoryHandle;
  chunks: Uint8Array[];
  bytes: number;
  nextIndex: number;
  startedAt: number;
  /** 提交时确定的文件名主干（可空，落盘前再兜底） */
  stem: string;
}

/** 一次只允许一张图在写（扩展侧也有同样约束；两端各自兜底） */
let activeSave: SaveSession | null = null;

/** 写入串行链：同一时刻只有一次 createWritable/write/close */
let writeChain: Promise<unknown> = Promise.resolve();

interface TerminalEntry {
  at: number;
  /** 成功结果 或 失败原因（两者互斥） */
  result?: SaveResult;
  error?: CollectorError;
}

/** saveId / requestId → 终态（幂等回执用；内存不持久化，刷新即失） */
const terminal = new Map<string, TerminalEntry>();

/**
 * saveId → 正在跑的写盘任务。COMMIT 的终态要等文件写完才登记，
 * 而扩展侧的桥每 500ms 会重发同一封信封（toolkit-bridge.js），重复 COMMIT
 * 若在写入期间到达会撞上"会话已清空 + 终态还没写"的空窗，被误判成
 * UNKNOWN_SAVE（用户随后看到"结果未确认"去重拖）。这里直接复用同一个 Promise。
 */
const pendingCommits = new Map<string, Promise<{ ok: true; data: SaveResult } | { ok: false; error: CollectorError }>>();

function pruneTerminal(): void {
  const now = Date.now();
  for (const [key, entry] of terminal) {
    if (now - entry.at > TERMINAL_TTL_MS) terminal.delete(key);
  }
  while (terminal.size > TERMINAL_KEEP) {
    const oldest = terminal.keys().next();
    if (oldest.done) break;
    terminal.delete(oldest.value);
  }
}

function rememberTerminal(key: string, entry: TerminalEntry): void {
  terminal.set(key, entry);
  pruneTerminal();
}

/** 记录一条终态（bridge 用它把 requestId 级结果也缓存下来，重复 COMMIT 原样返回） */
export function rememberRequestResult(
  requestId: string,
  payload: { result?: SaveResult; error?: CollectorError },
): void {
  rememberTerminal(requestId, { at: Date.now(), ...payload });
}

/** 查终态（bridge 处理重复请求时先查这里） */
export function peekTerminal(key: string): TerminalEntry | undefined {
  const entry = terminal.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TERMINAL_TTL_MS) {
    terminal.delete(key);
    return undefined;
  }
  return entry;
}

export async function beginSave(
  payload: BeginSavePayload,
): Promise<{ ok: true; data: BeginSaveResult } | { ok: false; error: CollectorError }> {
  const targetCheck = await readTarget();
  if (!targetCheck.target) {
    return {
      ok: false,
      error: targetCheck.blocked ?? { code: "NO_LIBRARY", message: "工具箱还没有打开图库" },
    };
  }
  if (!targetCheck.target.ready) {
    return {
      ok: false,
      error: targetCheck.blocked ?? { code: "NOT_READY", message: "工具箱还没准备好收图" },
    };
  }
  if (payload.target?.instanceId !== INSTANCE_ID || payload.target?.contextVersion !== contextVersion) {
    return {
      ok: false,
      error: { code: "STALE_TARGET", message: "工具箱的图库或目录变了，请重新拖一次图片" },
    };
  }
  const resolved = await resolveTargetDir(payload.target, payload.relPath ?? "");
  if (!resolved.ok) return resolved;
  // 权限在 BEGIN 这一刻已确认；写入阶段若被撤销，close 会失败并如实上报
  const entry = getEntry(useLibraryStore.getState().current?.libraryId ?? "");
  if (!entry) {
    return { ok: false, error: { code: "NO_LIBRARY", message: "图库未完成绑定" } };
  }
  const permission = await ensureEntryPermission(entry, false);
  if (!permission) {
    return {
      ok: false,
      error: { code: "PERMISSION_LOST", message: "图库目录权限失效，请回工具箱重新授权" },
    };
  }
  if (activeSave) {
    return { ok: false, error: { code: "BUSY", message: "工具箱正在保存上一张，请稍后" } };
  }
  const saveId = randomHex(12, "ys_");
  activeSave = {
    saveId,
    instanceId: INSTANCE_ID,
    relPath: resolved.resolved.relPath,
    dir: resolved.resolved.dir,
    chunks: [],
    bytes: 0,
    nextIndex: 0,
    startedAt: Date.now(),
    stem: "",
  };
  return { ok: true, data: { saveId } };
}

function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function fileChunk(
  payload: FileChunkPayload,
): { ok: true; data: FileChunkResult } | { ok: false; error: CollectorError } {
  const session = activeSave;
  if (!session || session.saveId !== payload.saveId) {
    // 已经提交过：把终态还回去（扩展重发块时不至于把成功结果当失败）
    const done = peekTerminal(String(payload.saveId));
    if (done) {
      return {
        ok: false,
        error: done.error ?? { code: "UNKNOWN_SAVE", message: "这张图已经保存完成" },
      };
    }
    return { ok: false, error: { code: "UNKNOWN_SAVE", message: "保存会话不存在或已过期" } };
  }
  if (payload.index !== session.nextIndex) {
    return {
      ok: false,
      error: {
        code: "CHUNK_OUT_OF_ORDER",
        message: `分块顺序错误：期望 ${session.nextIndex}，收到 ${payload.index}`,
      },
    };
  }
  const bytes = decodeBase64(payload.data ?? "");
  if (!bytes) {
    return { ok: false, error: { code: "BAD_REQUEST", message: "分块不是合法 base64" } };
  }
  if (bytes.length > MAX_CHUNK_BYTES) {
    return { ok: false, error: { code: "TOO_LARGE", message: "单个分块超过 256 KiB" } };
  }
  if (session.bytes + bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: { code: "TOO_LARGE", message: "图片超过 32 MiB 上限" } };
  }
  session.chunks.push(bytes);
  session.bytes += bytes.length;
  session.nextIndex += 1;
  return { ok: true, data: { nextIndex: session.nextIndex, bytes: session.bytes } };
}

/** 文件头嗅探：只认这七种，且不依赖 URL 后缀 / Content-Type */
export function sniffImageType(head: Uint8Array): { ext: string; mime: string } | null {
  if (head.length < 12) return null;
  const b = head;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return { ext: "png", mime: "image/png" };
  }
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...b.slice(start, end));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
    return { ext: "gif", mime: "image/gif" };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { ext: "webp", mime: "image/webp" };
  }
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return { ext: "bmp", mime: "image/bmp" };
  }
  if (ascii(4, 8) === "ftyp") {
    const major = ascii(8, 12);
    if (major === "avif" || major === "avis") {
      return { ext: "avif", mime: "image/avif" };
    }
    // 真实 AVIF 很常见是 ftyp mif1/msf1 + 兼容 brand 里带 avif：只认主 brand 会误杀
    const boxSize = Math.min(((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, b.length);
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
      const compatible = ascii(offset, offset + 4);
      if (compatible === "avif" || compatible === "avis") {
        return { ext: "avif", mime: "image/avif" };
      }
    }
  }
  return null;
}

/**
 * 文件名主干清洗：取 URL 末段/alt/页面标题的安全短名。
 * 去掉扩展名、Windows 禁用字符、保留设备名、末尾空格与点，并限长。
 */
export function sanitizeStem(raw: string): string {
  const text = (raw ?? "").normalize("NFC");
  const withoutExt = text.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  let stem = withoutExt.replace(FORBIDDEN_NAME_CHARS, " ").replace(/\s+/g, " ").trim();
  stem = stem.replace(/[. ]+$/, "");
  const chars = Array.from(stem);
  if (chars.length > MAX_STEM_CHARS) stem = chars.slice(0, MAX_STEM_CHARS).join("").trim();
  if (!stem) stem = "图片";
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  return stem;
}

/** 同名探测：返回 true 表示该名字已被占用（文件或同名目录都算） */
async function nameTaken(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return false;
    // TypeMismatchError（同名目录）等一律按"占用"处理，宁可换个名字也不覆盖
    return true;
  }
}

/** 生成 `主干-随机UUID.扩展名`，同名则重新生成（避免覆盖用户已有文件） */
async function uniqueFileName(
  dir: FileSystemDirectoryHandle,
  stem: string,
  ext: string,
): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const name = `${stem}-${randomHex(4, "")}.${ext}`;
    if (!(await nameTaken(dir, name))) return name;
  }
  return `${stem}-${randomHex(8, "")}.${ext}`;
}

async function commitSave(
  payload: CommitSavePayload,
): Promise<{ ok: true; data: SaveResult } | { ok: false; error: CollectorError }> {
  const session = activeSave;
  const done = peekTerminal(String(payload.saveId));
  if (done) {
    return done.result
      ? { ok: true, data: done.result }
      : { ok: false, error: done.error ?? { code: "WRITE_FAILED", message: "保存失败" } };
  }
  const inflight = pendingCommits.get(payload.saveId);
  if (inflight) return inflight;
  if (!session || session.saveId !== payload.saveId) {
    return { ok: false, error: { code: "UNKNOWN_SAVE", message: "保存会话不存在或已过期" } };
  }
  if (session.bytes !== payload.totalBytes) {
    const error: CollectorError = {
      code: "SIZE_MISMATCH",
      message: `字节数对不上：收到 ${session.bytes}，声明 ${payload.totalBytes}`,
    };
    activeSave = null;
    rememberTerminal(payload.saveId, { at: Date.now(), error });
    return { ok: false, error };
  }
  if (session.bytes === 0) {
    const error: CollectorError = { code: "INVALID_IMAGE", message: "没有收到图片数据" };
    activeSave = null;
    rememberTerminal(payload.saveId, { at: Date.now(), error });
    return { ok: false, error };
  }
  const all = new Uint8Array(session.bytes);
  let offset = 0;
  for (const chunk of session.chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  const type = sniffImageType(all);
  if (!type) {
    const error: CollectorError = {
      code: "INVALID_IMAGE",
      message: "这不是可识别的图片（JPEG/PNG/WebP/GIF/BMP/AVIF）",
    };
    activeSave = null;
    rememberTerminal(payload.saveId, { at: Date.now(), error });
    return { ok: false, error };
  }
  const stem = sanitizeStem(payload.stem || "");
  const dir = session.dir;
  const relBase = session.relPath;

  // 写入串行：同一时刻只跑一次 createWritable/write/close
  const task = writeChain.then(async () => {
    const fileName = await uniqueFileName(dir, stem, type.ext);
    let created = false;
    let writable: FileSystemWritableFileStream | null = null;
    try {
      const handle = await dir.getFileHandle(fileName, { create: true });
      created = true;
      writable = await handle.createWritable();
      await writable.write(new Blob([all], { type: type.mime }));
      await writable.close();
      writable = null;
      const result: SaveResult = {
        fileName,
        relPath: relBase ? `${relBase}/${fileName}` : fileName,
        bytes: session.bytes,
      };
      rememberTerminal(payload.saveId, { at: Date.now(), result });
      return { ok: true as const, data: result };
    } catch (err) {
      try {
        await writable?.abort();
      } catch {
        /* 流已不可用：忽略，下面继续清理文件 */
      }
      let residual = "";
      if (created) {
        try {
          await dir.removeEntry(fileName);
        } catch {
          residual = fileName;
        }
      }
      const detail = (err as Error)?.message ?? String(err);
      const error: CollectorError = {
        code: "WRITE_FAILED",
        message: residual
          ? `写入失败：${detail}（磁盘上可能残留 ${residual}，请手动删除）`
          : `写入失败：${detail}`,
      };
      rememberTerminal(payload.saveId, { at: Date.now(), error });
      return { ok: false as const, error };
    }
  });
  // 链上吞掉异常，避免一次失败卡死后续写入
  writeChain = task.catch(() => undefined);
  pendingCommits.set(payload.saveId, task);
  void task.then(
    () => pendingCommits.delete(payload.saveId),
    () => pendingCommits.delete(payload.saveId),
  );
  activeSave = null;
  return task;
}

export function commit(payload: CommitSavePayload) {
  return commitSave(payload);
}
export function getResult(
  payload: GetResultPayload,
): { ok: true; data: GetResultResult } | { ok: false; error: CollectorError } {
  const keys = [payload.saveId, payload.requestId].filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
  for (const key of keys) {
    const done = peekTerminal(key);
    if (done) {
      return done.result
        ? { ok: true, data: { status: "done", result: done.result } }
        : { ok: true, data: { status: "failed", error: done.error } };
    }
    if (activeSave && activeSave.saveId === key) {
      return { ok: true, data: { status: "pending" } };
    }
  }
  return { ok: true, data: { status: "unknown" } };
}

export function cancelSave(payload: { saveId: string }): CancelSaveResult {
  if (activeSave && activeSave.saveId === payload.saveId) {
    activeSave = null;
    return { cancelled: true };
  }
  return { cancelled: false };
}

/** 随机 id：`prefix + 十六进制`（bytes 个随机字节 → 2*bytes 位十六进制） */
function randomHex(bytes: number, prefix: string): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return prefix + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
