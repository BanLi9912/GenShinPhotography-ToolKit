"use strict";
/**
 * 原摄工具箱 · 拖拽采集后台（MV3 service worker，经典脚本）
 *
 * 职责（任务卡 §4.1 / §4.3 / §4.4）：
 *   - 选出唯一接收端（工具箱标签页），凭 `sender` 识别谁能发什么；
 *   - 在 host permissions 下抓图（不带 cookie、不改 Referer），校验状态码/大小/文件签名；
 *   - 分块（解码后 ≤ 192 KiB，低于协议 256 KiB 上限）转发给工具箱页面，再提交；
 *   - 全程单一活跃任务、限时、可恢复到「结果未确认」，绝不自动重试写文件。
 *
 * 后台可能被浏览器随时休眠：所有跨消息的状态要么在 `chrome.storage.session`，
 * 要么在收到消息时重新握手验证（实例 id 不匹配即视为失效）。
 */
const PROTOCOL_NS = "ystk-collector";
const PROTOCOL_VERSION = 1;

const TOOLKIT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** 解码后每块的字节数；协议上限 256 KiB，这里留足余量 */
const MAX_CHUNK_BYTES = 192 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const SAVE_BUDGET_MS = 60000;
const MESSAGE_TIMEOUT_MS = 3000;
const CHUNK_ACK_TIMEOUT_MS = 5000;

const KEY_RECEIVER = "receiver";
const KEY_LAST_TASK = "lastTask";
const KEY_OVERLAY_TABS = "overlayTabs";
const KEY_ENABLED = "collectorEnabled";

/**
 * 队列里还有几张（含正在跑的这张）。2026-11-18 用户口径：松手即关浮层，
 * 取图与写盘全交给后台 —— 于是"上一张还在保存"不能再挡人，改成排队串行；
 * 队列满才明确回 BUSY，不静默丢图。
 */
let queuedSaves = 0;
const MAX_PENDING_SAVES = 6;
/** 串行链：上一条彻底结束（含失败）才起下一条 */
let saveChain = Promise.resolve();
/** 在途去重键（目标目录 + 源地址）：同一次拖拽被重复投递时只存一份 */
const inFlightSaves = new Set();
/** 打开着采集浮层的标签页（目标变化时推作废通知） */
const overlayTabs = new Set();

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function newId(prefix) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function errorOf(code, message) {
  return { ok: false, error: { code, message } };
}

function isToolkitUrl(url) {
  if (typeof url !== "string") return false;
  return TOOLKIT_ORIGINS.some((origin) => url === origin || url.startsWith(`${origin}/`));
}

async function isEnabled() {
  const stored = await chrome.storage.local.get(KEY_ENABLED);
  return stored[KEY_ENABLED] !== false;
}

async function readSession(key, fallback) {
  const stored = await chrome.storage.session.get(key);
  return key in stored ? stored[key] : fallback;
}

async function writeSession(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

function rememberOverlayTab(tabId) {
  if (typeof tabId !== "number") return;
  overlayTabs.add(tabId);
  void writeSession(KEY_OVERLAY_TABS, [...overlayTabs]);
}

function forgetOverlayTab(tabId) {
  if (overlayTabs.delete(tabId)) void writeSession(KEY_OVERLAY_TABS, [...overlayTabs]);
}

/* ------------------------------------------------------------------ *
 * 与工具箱页面通信
 * ------------------------------------------------------------------ */

/**
 * 把信封发给指定标签页的顶层 frame，由 toolkit-bridge.js 转交给页面。
 * 超时 / 页面不在 → 结构化错误，不抛异常。
 */
function sendToToolkit(tabId, envelope, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(errorOf("TIMEOUT", "工具箱没有在限时内回应"));
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: "toolkit/request", envelope, timeoutMs: Math.max(500, timeoutMs - 200) },
        { frameId: 0 },
        (response) => {
          if (chrome.runtime.lastError) {
            finish(errorOf("NO_RECEIVER", "工具箱页面没有响应（可能已关闭或未注入桥接）"));
            return;
          }
          if (!response) {
            finish(errorOf("INTERNAL", "工具箱页面没有回执"));
            return;
          }
          finish(response);
        },
      );
    } catch (error) {
      finish(errorOf("NO_RECEIVER", `发送失败：${String(error)}`));
    }
  });
}

function callPage(tabId, type, payload, timeoutMs) {
  const envelope = {
    ns: PROTOCOL_NS,
    v: PROTOCOL_VERSION,
    kind: "request",
    type,
    requestId: newId("rq_"),
    payload: payload ?? {},
  };
  return sendToToolkit(tabId, envelope, timeoutMs ?? MESSAGE_TIMEOUT_MS);
}

/** HELLO 探测：能回应就说明这条标签页真的挂着工具箱页面 */
async function probeTab(tabId) {
  const response = await callPage(tabId, "HELLO", {}, 2000);
  if (!response.ok || !response.data) return null;
  const data = response.data;
  if (typeof data.instanceId !== "string") return null;
  return {
    tabId,
    instanceId: data.instanceId,
    libraryName: data.libraryName ?? null,
    baseRelPath: data.baseRelPath ?? "",
    displayPath: data.displayPath ?? "参考图库",
    theme: data.theme === "dark" ? "dark" : "light",
    ready: Boolean(data.ready),
  };
}

async function listToolkitTabs() {
  const patterns = TOOLKIT_ORIGINS.map((origin) => `${origin}/*`);
  const tabs = await chrome.tabs.query({ url: patterns });
  return tabs.filter((tab) => typeof tab.id === "number");
}

async function discoverCandidates() {
  const tabs = await listToolkitTabs();
  const probes = await Promise.all(
    tabs.map(async (tab) => {
      const probe = await probeTab(tab.id);
      return probe ? { ...probe, url: tab.url ?? "", title: tab.title ?? "" } : null;
    }),
  );
  return probes.filter(Boolean);
}

/**
 * 解析接收端：先验证已存的选择（实例 id 必须一致），失效则重新发现。
 * 只有一个候选时自动选定；多个时不猜、不群发（任务卡 §4.1）。
 */
async function ensureReceiver() {
  const stored = await readSession(KEY_RECEIVER, null);
  if (stored && typeof stored.tabId === "number") {
    const probe = await probeTab(stored.tabId);
    if (probe && probe.instanceId === stored.instanceId) {
      return { ok: true, receiver: { ...probe, url: stored.url ?? "" } };
    }
    // 页面刷新/关闭/换实例：旧 tabId 不再可信
    await chrome.storage.session.remove(KEY_RECEIVER);
  }

  const candidates = await discoverCandidates();
  if (candidates.length === 0) {
    return errorOf("NO_RECEIVER", "没有找到可用的工具箱页面（请打开 /library 并授权参考图库）");
  }
  if (candidates.length > 1) {
    const error = errorOf("MULTIPLE_TABS", "打开了多个工具箱页面，请在扩展弹窗里选定接收端");
    error.candidates = candidates;
    return error;
  }
  const only = candidates[0];
  await writeSession(KEY_RECEIVER, {
    tabId: only.tabId,
    instanceId: only.instanceId,
    url: only.url,
  });
  return { ok: true, receiver: only };
}

/* ------------------------------------------------------------------ *
 * 图片获取与类型判定
 * ------------------------------------------------------------------ */

/** 文件头嗅探：与工具箱 receiver.ts 的 sniffImageType 保持一致（不依赖后缀/Content-Type） */
function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  const ascii = (start, end) => String.fromCharCode(...b.subarray(start, end));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return "png";
  }
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if (ascii(4, 8) === "ftyp") {
    const major = ascii(8, 12);
    if (major === "avif" || major === "avis") return "avif";
    // 真实 AVIF 很常见是 ftyp mif1/msf1 + 兼容 brand 里带 avif（只认主 brand 会误杀）
    const boxSize = Math.min((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3], b.length);
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
      const compatible = ascii(offset, offset + 4);
      if (compatible === "avif" || compatible === "avis") return "avif";
    }
  }
  return null;
}

function decodeDataUrl(src) {
  const comma = src.indexOf(",");
  if (comma < 0) throw errorOf("INVALID_IMAGE", "data: 地址格式不完整");
  const meta = src.slice(5, comma);
  const body = src.slice(comma + 1);
  if (!/^image\//i.test(meta)) throw errorOf("INVALID_IMAGE", "data: 不是图片类型");
  let bytes;
  if (/;base64/i.test(meta)) {
    let binary;
    try {
      binary = atob(body);
    } catch {
      throw errorOf("INVALID_IMAGE", "data: base64 解码失败");
    }
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(body));
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw errorOf("TOO_LARGE", "图片超过 32 MiB 限额");
  return bytes;
}

/** 边读边计数：超过上限立刻停，不把巨大错误页读进内存 */
async function readCapped(response, cap) {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > cap) throw errorOf("TOO_LARGE", "图片超过 32 MiB 限额");
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw errorOf("TOO_LARGE", "图片超过 32 MiB 限额");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * 取图：http(s) 走后台 fetch（带 host permissions 才能跨域），data: 直接解码。
 * 带 `credentials: "omit"`（不提取登录 cookie），不设置 Referer 绕过站点校验。
 */
async function loadImage(src, deadline) {
  if (/^data:/i.test(src)) {
    const bytes = decodeDataUrl(src);
    const ext = sniffImageType(bytes);
    if (!ext) throw errorOf("INVALID_IMAGE", "data: 内容不是可识别的图片");
    return { bytes, ext };
  }
  if (!/^https?:\/\//i.test(src)) {
    throw errorOf("UNSUPPORTED_SOURCE", "只支持 http(s) 与 data:image 图片地址");
  }

  const budget = Math.max(1000, Math.min(FETCH_TIMEOUT_MS, deadline - Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const response = await fetch(src, {
      signal: controller.signal,
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
    });
    if (!response.ok) {
      throw errorOf("FETCH_FAILED", `取图失败：HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw errorOf("TOO_LARGE", "图片超过 32 MiB 限额");
    }
    const bytes = await readCapped(response, MAX_IMAGE_BYTES);
    const ext = sniffImageType(bytes);
    if (!ext) {
      const contentType = response.headers.get("content-type") ?? "未知";
      throw errorOf(
        "INVALID_IMAGE",
        `返回的不是可识别的图片（Content-Type: ${contentType}，可能是登录页或防盗链页面）`,
      );
    }
    return { bytes, ext };
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw errorOf("TIMEOUT", "取图超时（20 秒）");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 候选挑选：原图优先，像素面积说了算
 * ------------------------------------------------------------------ */

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

/** 长边 ≥ 1600 就算高清：够了就停，不再多抓候选（守住 60s 保存预算） */
const GOOD_ENOUGH_AREA = 1600 * 1600;
/** 一次保存最多试几张候选（content.js 也按 4 条截断，这里兜底） */
const MAX_CANDIDATES = 4;

/** 候选去重/裁剪：主地址排第一，其余按 content.js 给的"更像原图"顺序 */
function normalizeCandidates(raw, primary) {
  const list = [];
  const push = (value) => {
    if (typeof value !== "string" || !value) return;
    if (list.includes(value) || list.length >= MAX_CANDIDATES) return;
    list.push(value);
  };
  push(primary);
  if (Array.isArray(raw)) {
    for (const item of raw) push(item);
  }
  return list;
}

/** 解码后像素面积（挑"最大那张"的唯一裁判）；解不了返回 0，退化成按字节数排序 */
async function pixelAreaOf(bytes, ext) {
  if (typeof createImageBitmap !== "function") return 0;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(
      new Blob([bytes], { type: MIME_BY_EXT[ext] ?? "application/octet-stream" }),
    );
    return (bitmap.width || 0) * (bitmap.height || 0);
  } catch {
    return 0;
  } finally {
    try {
      bitmap?.close?.();
    } catch {
      // 已释放/不支持，忽略
    }
  }
}

/** 末段 `@尺寸后缀` 之前的地址（同源变体判据；没有后缀返回空串） */
function variantBaseOf(src) {
  if (typeof src !== "string" || !src) return "";
  const hashAt = src.indexOf("#");
  const noHash = hashAt >= 0 ? src.slice(0, hashAt) : src;
  const queryAt = noHash.indexOf("?");
  const pathPart = queryAt >= 0 ? noHash.slice(0, queryAt) : noHash;
  const slash = pathPart.lastIndexOf("/");
  const head = pathPart.slice(0, slash + 1);
  const tail = pathPart.slice(slash + 1);
  const at = tail.indexOf("@");
  return at > 0 ? `${head}${tail.slice(0, at)}` : "";
}

/**
 * 逐个取候选，返回像素面积最大的一张；全失败才抛最后一个错误。
 * 不按 URL 规则猜"哪条是原图"——规则只用来排序，真正取舍看解码后的像素。
 * 已经拿到某个地址的原图后，它的 `@尺寸` 变体（必然更小或同尺寸）直接跳过。
 */
async function pickImage(candidates, deadline) {
  let best = null;
  let lastError = null;
  for (const candidate of candidates) {
    if (Date.now() > deadline - 5000) break;
    const base = variantBaseOf(candidate);
    // 已拿到某个地址的原图（best.src）时，它的 @尺寸变体不必再抓
    if (best && base && (best.src === base || best.base === base)) continue;
    try {
      const got = await loadImage(candidate, deadline);
      const area = await pixelAreaOf(got.bytes, got.ext);
      const next = { ...got, src: candidate, area, base };
      const bigger =
        !best || area > best.area || (area === 0 && next.bytes.byteLength > best.bytes.byteLength);
      if (bigger) best = next;
      if (area >= GOOD_ENOUGH_AREA) break;
    } catch (error) {
      lastError = error?.error ? error : errorOf("INTERNAL", String(error));
    }
  }
  if (best) return best;
  throw lastError ?? errorOf("INVALID_IMAGE", "没有取到可用的图片");
}

/* ------------------------------------------------------------------ *
 * 辅助：文件名主干、base64
 * ------------------------------------------------------------------ */

/** Windows 禁用字符 + 控制字符（用 \p{Cc} 表达控制字符，避免正则里写裸控制码） */
const FORBIDDEN_NAME_CHARS = /[<>:"/\\|?*\p{Cc}]/gu;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_STEM_CHARS = 40;

function cleanStem(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.normalize("NFC").trim();
  if (!text) return "";
  text = text.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  text = text.replace(FORBIDDEN_NAME_CHARS, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/[. ]+$/, "");
  const chars = Array.from(text);
  if (chars.length > MAX_STEM_CHARS) text = chars.slice(0, MAX_STEM_CHARS).join("").trim();
  if (!text) return "";
  if (WINDOWS_RESERVED.test(text)) text = `_${text}`;
  return text;
}

function urlLastSegment(src) {
  try {
    const withoutQuery = src.split("#")[0].split("?")[0];
    const last = withoutQuery.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

/** 作者昵称上限：给主干留够位置（前缀 + 主干一起受 MAX_STEM_CHARS 约束） */
const MAX_AUTHOR_CHARS = 24;

/** 昵称清洗：去掉零宽/方向控制符（X 上复制来的名字偶尔夹带），压空白、限长 */
function cleanAuthor(raw) {
  if (typeof raw !== "string") return "";
  const text = raw
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const chars = Array.from(text);
  return chars.length > MAX_AUTHOR_CHARS
    ? chars.slice(0, MAX_AUTHOR_CHARS).join("").trim()
    : text;
}

/**
 * 前缀合成：`作者_主干`，总长仍受 MAX_STEM_CHARS 约束（昵称最长 24 → 主干至多 15，
 * 截断只发生在主干尾部；随机后缀由接收端另加，不在这里）。
 */
function joinAuthor(author, stem) {
  const label = cleanStem(cleanAuthor(author));
  if (!label) return stem;
  const budget = MAX_STEM_CHARS - Array.from(label).length - 1;
  const chars = Array.from(stem);
  const tail = chars.length > budget ? chars.slice(0, budget).join("").trim() : stem;
  return tail ? label + "_" + tail : label;
}

/** 默认主干：alt → URL 末段 → 页面标题 → 图片；有作者昵称（X.com 适配）就加前缀 */
function stemFor(author, src, alt, pageTitle) {
  const candidates = [alt, urlLastSegment(src), pageTitle];
  let base = "图片";
  for (const candidate of candidates) {
    const cleaned = cleanStem(candidate ?? "");
    if (cleaned) {
      base = cleaned;
      break;
    }
  }
  return joinAuthor(author, base);
}

function toBase64(bytes) {
  const step = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ *
 * 保存流程
 * ------------------------------------------------------------------ */

/** 结果保留在弹窗「上一次采集」里；浮层关得快，失败再给工具栏图标挂个「!」 */
function reportBadge(task) {
  try {
    if (typeof chrome.action?.setBadgeText !== "function") return;
    if (task.status === "failed" || task.status === "unconfirmed") {
      void chrome.action.setBadgeText({ text: "!" });
      void chrome.action.setTitle({
        title: `原摄工具箱 · 拖拽采集：${task.error?.message ?? "上次保存失败"}`,
      });
      return;
    }
    if (task.status === "saved") {
      void chrome.action.setBadgeText({ text: "" });
      void chrome.action.setTitle({ title: "原摄工具箱 · 拖拽采集" });
    }
  } catch {
    // 无工具栏图标的运行环境（自测/无头）忽略
  }
}

async function setLastTask(task) {
  await writeSession(KEY_LAST_TASK, { ...task, at: Date.now() });
  reportBadge(task);
}

/** 取消一次已 BEGIN 的会话（尽力而为：超时/失联时页面自己也会按 60 秒清理） */
async function cancelActive(receiver, saveId) {
  if (!receiver || !saveId) return;
  await callPage(receiver.tabId, "CANCEL_SAVE", { saveId }, MESSAGE_TIMEOUT_MS);
}

/** 去重键：同一目标目录 + 同一源地址 = 同一次拖拽的重复提交 */
function saveKeyOf(payload) {
  return `${payload?.relPath ?? ""}\u0001${payload?.src ?? ""}`;
}

/**
 * 入队（串行）：保证"一次拖拽只写一个文件"——
 * 同一 (目标目录, 源地址) 还在队列里/正在写时，重复提交直接忽略（DUPLICATE）。
 */
function enqueueSave(payload) {
  const job = { startedAt: Date.now(), saveId: null, tabId: null };
  if (queuedSaves >= MAX_PENDING_SAVES) {
    return Promise.resolve(
      errorOf("BUSY", `后台保存队列已满（最多 ${MAX_PENDING_SAVES} 张），这张没有写`),
    );
  }
  const key = saveKeyOf(payload ?? {});
  if (inFlightSaves.has(key)) {
    return Promise.resolve(errorOf("DUPLICATE", "这张图这次拖拽已经在保存，重复提交已忽略"));
  }
  inFlightSaves.add(key);
  queuedSaves += 1;
  const run = saveChain.then(async () => {
    try {
      return await performSave(job, payload ?? {});
    } catch (error) {
      const message = error?.error?.message ?? error?.message ?? String(error);
      const code = error?.error?.code ?? "INTERNAL";
      return errorOf(code, message);
    }
  });
  // 链上吞掉异常，避免一次失败卡死后续保存
  saveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run.finally(() => {
    queuedSaves -= 1;
    inFlightSaves.delete(key);
  });
}

async function performSave(job, payload) {
  const { relPath, src, candidates, sourceKind, pageUrl, pageTitle, alt, author, target } = payload;
  if (typeof src !== "string" || src.length === 0) return errorOf("BAD_REQUEST", "缺少图片地址");
  if (typeof relPath !== "string") return errorOf("BAD_REQUEST", "缺少目标目录");
  if (!target || typeof target.instanceId !== "string") {
    return errorOf("BAD_REQUEST", "缺少工具箱目标快照");
  }
  if (!(await isEnabled())) {
    return errorOf("BAD_REQUEST", "采集开关已关闭");
  }

  const resolved = await ensureReceiver();
  if (!resolved.ok) {
    await setLastTask({ status: "failed", error: resolved.error });
    return resolved;
  }
  const receiver = resolved.receiver;
  job.tabId = receiver.tabId;

  if (target.instanceId !== receiver.instanceId) {
    const error = errorOf("STALE_TARGET", "工具箱页面已刷新，请重新拖一次图片");
    await setLastTask({ status: "failed", error });
    return error;
  }

  // 1) BEGIN：工具箱此刻校验快照、锁定目录并返回 saveId（此后目标冻结）
  const begin = await callPage(
    receiver.tabId,
    "BEGIN_SAVE",
    {
      target: { instanceId: target.instanceId, contextVersion: target.contextVersion },
      relPath,
      source: {
        urlKind: sourceKind === "data" ? "data" : "http",
        pageUrl: typeof pageUrl === "string" ? pageUrl : "",
        pageTitle: typeof pageTitle === "string" ? pageTitle : "",
        alt: typeof alt === "string" ? alt : "",
      },
    },
    MESSAGE_TIMEOUT_MS + 2000,
  );
  if (!begin.ok) {
    await setLastTask({ status: "failed", error: begin.error });
    return begin;
  }
  job.saveId = begin.data.saveId;
  const saveId = job.saveId;
  const deadline = Date.now() + SAVE_BUDGET_MS;
  await setLastTask({ status: "saving", relPath, libraryName: receiver.libraryName ?? "" });

  // 2) 取图：候选逐个取回、按解码像素面积挑最大的一张（优先原图，失败才回退渲染图）
  let image;
  try {
    image = await pickImage(normalizeCandidates(candidates, src), deadline);
    console.info(
      `[ystk-collector] 取图：${image.src}（${image.bytes.byteLength} 字节，${image.area} 像素）`,
    );
  } catch (error) {
    await cancelActive(receiver, saveId);
    const failure = error?.error ? error : errorOf("INTERNAL", String(error));
    await setLastTask({ status: "failed", error: failure.error });
    return { ok: false, error: failure.error };
  }

  const total = image.bytes.byteLength;
  if (total === 0) {
    await cancelActive(receiver, saveId);
    const error = { code: "INVALID_IMAGE", message: "取到的图片是空的" };
    await setLastTask({ status: "failed", error });
    return { ok: false, error };
  }

  // 3) 分块：严格顺序、逐块确认
  for (let offset = 0, index = 0; offset < total; offset += MAX_CHUNK_BYTES, index += 1) {
    if (Date.now() > deadline) {
      await cancelActive(receiver, saveId);
      const error = { code: "TIMEOUT", message: "保存超时（60 秒），已取消" };
      await setLastTask({ status: "failed", error });
      return { ok: false, error };
    }
    const slice = image.bytes.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, total));
    const ack = await callPage(
      receiver.tabId,
      "FILE_CHUNK",
      { saveId, index, data: toBase64(slice) },
      CHUNK_ACK_TIMEOUT_MS,
    );
    if (!ack.ok) {
      await cancelActive(receiver, saveId);
      await setLastTask({ status: "failed", error: ack.error });
      return ack;
    }
  }

  // 4) COMMIT：回执丢失时查终态，绝不谎报失败后自动重来
  const remainder = Math.max(5000, deadline - Date.now());
  const commit = await callPage(
    receiver.tabId,
    "COMMIT_SAVE",
    { saveId, totalBytes: total, stem: stemFor(author, image.src ?? src, alt, pageTitle) },
    remainder,
  );
  if (commit.ok) {
    await setLastTask({
      status: "saved",
      fileName: commit.data.fileName,
      relPath: commit.data.relPath,
      libraryName: receiver.libraryName ?? "",
    });
    return commit;
  }

  const lost = ["TIMEOUT", "NO_RECEIVER", "UNKNOWN_SAVE", "INTERNAL"].includes(commit.error?.code);
  if (lost) {
    const settled = await callPage(receiver.tabId, "GET_RESULT", { saveId }, MESSAGE_TIMEOUT_MS);
    if (settled.ok && settled.data?.status === "done" && settled.data.result) {
      await setLastTask({
        status: "saved",
        fileName: settled.data.result.fileName,
        relPath: settled.data.result.relPath,
        libraryName: receiver.libraryName ?? "",
      });
      return { ok: true, data: settled.data.result };
    }
    if (settled.ok && settled.data?.status === "failed") {
      await setLastTask({ status: "failed", error: settled.data.error });
      return { ok: false, error: settled.data.error };
    }
    const unknown = {
      code: "TIMEOUT",
      message: "结果未确认：请检查目标目录后再决定是否重拖（不会自动重试）",
    };
    await setLastTask({ status: "unconfirmed", error: unknown });
    return { ok: false, error: unknown };
  }

  await setLastTask({ status: "failed", error: commit.error });
  return commit;
}

/* ------------------------------------------------------------------ *
 * 目标变化广播
 * ------------------------------------------------------------------ */

async function broadcastTargetChanged(payload) {
  const stored = await readSession(KEY_OVERLAY_TABS, []);
  if (Array.isArray(stored)) {
    for (const tabId of stored) {
      if (typeof tabId === "number") overlayTabs.add(tabId);
    }
  }
  for (const tabId of [...overlayTabs]) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "collector/target-changed", payload });
    } catch {
      forgetOverlayTab(tabId);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */

function roleOf(sender) {
  if (!sender) return "unknown";
  if (!sender.tab) return "extension";
  if ((sender.frameId ?? 0) !== 0) return "subframe";
  return isToolkitUrl(sender.url) ? "toolkit" : "page";
}

async function handlePageMessage(message, sender) {
  switch (message.type) {
    case "collector/hello": {
      const enabled = await isEnabled();
      const resolved = await ensureReceiver();
      if (!resolved.ok) {
        return {
          ok: true,
          data: {
            enabled,
            connected: false,
            busy: queuedSaves > 0,
            queued: queuedSaves,
            target: null,
            blocked: resolved.error,
          },
        };
      }
      const receiver = resolved.receiver;
      const targetResponse = await callPage(receiver.tabId, "GET_TARGET", {}, MESSAGE_TIMEOUT_MS);
      if (!targetResponse.ok) {
        return {
          ok: true,
          data: {
            enabled,
            connected: false,
            busy: queuedSaves > 0,
            queued: queuedSaves,
            target: null,
            blocked: targetResponse.error,
          },
        };
      }
      const { target, blocked } = targetResponse.data ?? {};
      if (!target) {
        return {
          ok: true,
          data: {
            enabled,
            connected: false,
            busy: queuedSaves > 0,
            queued: queuedSaves,
            target: null,
            blocked: blocked ?? { code: "NOT_READY", message: "工具箱还没准备好收图" },
          },
        };
      }
      const notReady = target.ready
        ? null
        : (blocked ?? { code: "NOT_READY", message: "工具箱还没准备好收图（正在扫描或未就绪）" });
      return {
        ok: true,
        data: {
          enabled,
          connected: true,
          busy: queuedSaves > 0,
          queued: queuedSaves,
          target: {
            ...target,
            displayPath: displayPathOf(target.libraryName, target.baseRelPath),
          },
          blocked: notReady,
        },
      };
    }
    case "collector/list-children": {
      const resolved = await ensureReceiver();
      if (!resolved.ok) return resolved;
      const payload = message.payload ?? {};
      return callPage(resolved.receiver.tabId, "LIST_CHILDREN", payload, MESSAGE_TIMEOUT_MS + 1500);
    }
    case "collector/save": {
      if (typeof sender.tab?.id !== "number") return errorOf("BAD_REQUEST", "缺少来源标签页");
      if (!(await isEnabled())) return errorOf("BAD_REQUEST", "采集开关已关闭");
      return enqueueSave(message.payload);
    }
    case "collector/overlay": {
      if (message.payload?.open === true) rememberOverlayTab(sender.tab?.id);
      else forgetOverlayTab(sender.tab?.id);
      return { ok: true, data: { tracked: overlayTabs.size } };
    }
    default:
      return errorOf("BAD_REQUEST", `未知的页面消息：${String(message.type)}`);
  }
}

async function handleToolkitMessage(message) {
  if (message.type !== "toolkit/event") {
    return errorOf("BAD_REQUEST", `未知的工具箱消息：${String(message.type)}`);
  }
  const payload = message.payload?.payload ?? {};
  void broadcastTargetChanged(payload);
  return { ok: true, data: { broadcast: overlayTabs.size } };
}

async function popupState() {
  const [enabled, stored, lastTask] = await Promise.all([
    isEnabled(),
    readSession(KEY_RECEIVER, null),
    readSession(KEY_LAST_TASK, null),
  ]);
  let receiver = null;
  if (stored && typeof stored.tabId === "number") {
    const probe = await probeTab(stored.tabId);
    if (probe) receiver = { ...probe, url: stored.url ?? "" };
  }
  const candidates = await discoverCandidates();
  return {
    ok: true,
    data: {
      enabled,
      receiver,
      candidates,
      lastTask,
      busy: queuedSaves > 0,
      queued: queuedSaves,
    },
  };
}

async function handlePopupMessage(message) {
  switch (message.type) {
    case "popup/state":
      return popupState();
    case "popup/set-enabled": {
      const enabled = message.payload?.enabled !== false;
      await chrome.storage.local.set({ [KEY_ENABLED]: enabled });
      return popupState();
    }
    case "popup/select": {
      const tabId = message.payload?.tabId;
      if (typeof tabId !== "number") return errorOf("BAD_REQUEST", "缺少标签页 id");
      const probe = await probeTab(tabId);
      if (!probe) return errorOf("NO_RECEIVER", "这个标签页没有回应（可能不是工具箱页面）");
      // 选择立刻落盘：此后不因用户切标签页而重选（任务卡 §4.1）
      let url = "";
      try {
        const tab = await chrome.tabs.get(tabId);
        url = typeof tab.url === "string" ? tab.url : "";
      } catch {
        url = "";
      }
      await writeSession(KEY_RECEIVER, { tabId, instanceId: probe.instanceId, url });
      return popupState();
    }
    default:
      return errorOf("BAD_REQUEST", `未知的弹窗消息：${String(message.type)}`);
  }
}

function displayPathOf(libraryName, baseRelPath) {
  const segments = [libraryName ?? "参考图库", ...String(baseRelPath ?? "").split("/")].filter(
    (part) => part && part.length > 0,
  );
  return segments.join("/");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (!message || typeof message.type !== "string") {
      sendResponse(errorOf("BAD_REQUEST", "消息缺少 type"));
      return;
    }
    const role = roleOf(sender);
    try {
      if (role === "page") {
        if (!/^collector\//.test(message.type)) {
          sendResponse(errorOf("BAD_REQUEST", "普通网页只能发采集消息"));
          return;
        }
        sendResponse(await handlePageMessage(message, sender));
        return;
      }
      if (role === "toolkit") {
        if (!/^toolkit\//.test(message.type)) {
          sendResponse(errorOf("BAD_REQUEST", "工具箱页面只能发桥接事件"));
          return;
        }
        sendResponse(await handleToolkitMessage(message));
        return;
      }
      if (role === "extension") {
        if (!/^popup\//.test(message.type)) {
          sendResponse(errorOf("BAD_REQUEST", "扩展页面只能发弹窗消息"));
          return;
        }
        sendResponse(await handlePopupMessage(message));
        return;
      }
      sendResponse(errorOf("BAD_REQUEST", "不接受来自这个上下文的采集消息"));
    } catch (error) {
      sendResponse(errorOf("INTERNAL", String(error?.message ?? error)));
    }
  })();
  return true; // 异步回执
});

/* 标签页关闭/导航：清掉不再可信的接收端与浮层登记 */
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetOverlayTab(tabId);
  void (async () => {
    const stored = await readSession(KEY_RECEIVER, null);
    if (stored && stored.tabId === tabId) await chrome.storage.session.remove(KEY_RECEIVER);
  })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void (async () => {
    const stored = await readSession(KEY_RECEIVER, null);
    if (stored && stored.tabId === tabId && !isToolkitUrl(changeInfo.url)) {
      await chrome.storage.session.remove(KEY_RECEIVER);
    }
  })();
});
