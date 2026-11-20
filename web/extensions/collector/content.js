"use strict";
/**
 * 原摄工具箱 · 网页侧采集脚本
 *
 * 职责：识别用户真实拖动的 `<img>`、开一次短期采集会话、把浮层（overlay.js）
 * 画出来，松手时把「图源 + 投放目录」交给后台去取图与落盘。
 * 不取图、不写文件、不解析目录——那些在 background.js 与工具箱接收端。
 *
 * 安全纪律（任务卡 §4.3）：
 *   - 只响应 `isTrusted` 的 dragstart/drop；网页自己 dispatchEvent 的合成拖拽一律忽略；
 *   - 不监听宿主页面的 postMessage（普通网页与扩展之间没有任何页面级通道）；
 *   - 只接受后台发来的消息（`sender` 由浏览器保证，无法伪造成外部网页）。
 */
(() => {
  if (globalThis.YSTK_CONTENT_READY) return;
  globalThis.YSTK_CONTENT_READY = true;

  const HELLO_TIMEOUT_MS = 1500;
  const LIST_TIMEOUT_MS = 4500;
  /** 后台队列最坏情况（6 张 × 单张 60s）留足余量：这里只用于日志口径，不取消真实保存 */
  const SAVE_TIMEOUT_MS = 300000;
  const REVALIDATE_MS = 5000;

  const SUPPORTED_TITLE = "仅支持 http(s) 图片与小于限额的 data:image";

  /* ---------------- 原图候选（2026-11-18 用户反馈：抓到的常是缩略图变体） ---------------- */

  /**
   * 站点"处理后缀"：B 站等 CDN 用 `<原图>@1280w_1280h_1c.avif` 现生成缩略图，
   * 去掉 `@...` 才是原图（实测 B 站 new_dyn：`...jpg@1280w_1280h_1c.avif` 只有
   * 228 KB，去掉后缀的 `...jpg` 是 3.8 MB 的 jpeg 原图）。只认末段里的 `@`，
   * 避免误伤路径其它部分。
   */
  const SIZE_QUERY_RE =
    /(^|[?&])(x-oss-process|x-image-process|imageMogr2?|resize|thumbnail|w|width|h|height|q|quality|fit|crop)=/i;
  const IMAGE_PATH_RE = /\.(?:jpe?g|png|webp|gif|bmp|avif|jxl|heic)$/i;
  /** 网页把原图挂在自定义属性上的常见写法（懒加载多数还是同一张） */
  const DATA_SRC_ATTRS = [
    "data-original",
    "data-original-src",
    "data-src",
    "data-full",
    "data-full-src",
    "data-large",
    "data-large-src",
    "data-zoom-src",
    "data-raw",
    "data-image",
    "data-lazy-src",
  ];
  /** 一次保存最多试几张候选：够覆盖"原图 / srcset 最大 / 兜底渲染图"，又不至于拖垮 60s 预算 */
  const MAX_CANDIDATES = 4;

  /* ---------------- 作者昵称（文件名前缀；先只做 X.com） ---------------- */

  /** 昵称上限：留出主干空间（文件名主干总长 40 字符，见 background.js stemFor） */
  const MAX_AUTHOR_CHARS = 24;
  const X_TWEET_SELECTOR = 'article[data-testid="tweet"]';
  /** 引用推（转推内容）是内嵌的 div，最近的那层才是这张图的作者 */
  const X_QUOTED_SELECTOR = 'div[data-testid="tweet"]';
  const X_AUTHOR_SELECTOR = '[data-testid="User-Name"]';

  /** 昵称清洗：去掉零宽/方向控制符，压空白、限长（文件名的禁用字符交给后台统一清洗） */
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

  /** 选择器命中后返回第一个非空文本（元素可能一个都没有，一律当"没抓到"） */
  function firstTextOf(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") return "";
    for (const node of root.querySelectorAll(selector)) {
      const text = cleanAuthor(node.textContent ?? "");
      if (text) return text;
    }
    return "";
  }

  /** 作者区整段文本里挖昵称：去掉 @句柄 后剩下的那段（weiei / @weiei483 → weiei） */
  function nameFromText(text) {
    const clean = cleanAuthor(text ?? "");
    if (!clean) return "";
    return clean.replace(/@[A-Za-z0-9_]{1,15}/g, "").replace(/\s+/g, " ").trim();
  }

  /** @weiei483 / /weiei483 / https://x.com/weiei483/status/1 → weiei483 */
  function handleFrom(value) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return "";
    const at = /@([A-Za-z0-9_]{1,15})/.exec(text);
    if (at) return at[1];
    const path = /^(?:https?:\/\/[^/]+)?\/([A-Za-z0-9_]{1,15})(?:\/status\/|$)/.exec(text);
    return path ? path[1] : "";
  }

  /** 推文里那条 /账号/status/… 链接就是账号的兜底来源（昵称和 @句柄都抓不到时） */
  function handleFromStatusLink(tweet) {
    if (!tweet || typeof tweet.querySelectorAll !== "function") return "";
    for (const anchor of tweet.querySelectorAll('a[href*="/status/"]')) {
      const href = typeof anchor.getAttribute === "function" ? anchor.getAttribute("href") : "";
      const handle = handleFrom(href ?? "");
      if (handle) return handle;
    }
    return "";
  }

  /** 从一块作者区里取名字：显示名 → 整段文本里的昵称 → @句柄（都拿不到返回空串） */
  function readAuthorBox(box) {
    if (!box) return "";
    const display = firstTextOf(box, 'a:not([tabindex="-1"])');
    if (display && !display.startsWith("@")) return display;

    const fromText = nameFromText(box.textContent ?? "");
    if (fromText) return fromText;

    return handleFrom(firstTextOf(box, 'a[tabindex="-1"]')) || handleFrom(box.textContent ?? "");
  }

  /**
   * 点开大图（灯箱）时图片不在推文节点里，closest 一定拿不到。
   * 退法：沿祖先往上找「刚好只含一个作者区」的那层——灯箱根节点就是图片和推文信息区共同的那层；
   * 出现两块以上作者区说明已经爬到一串推文里了，立即停手，绝不错认别人的昵称。
   */
  function authorFromAncestors(image) {
    let node = image.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1) {
      if (node === document.body || node === document.documentElement) break;
      if (typeof node.querySelectorAll === "function") {
        const boxes = node.querySelectorAll(X_AUTHOR_SELECTOR);
        if (boxes.length > 1) break;
        if (boxes.length === 1) {
          const got = readAuthorBox(boxes[0]);
          if (got) return got;
        }
      }
      node = node.parentElement;
    }
    return "";
  }

  /** 页面地址里的账号：/asteroid_ill/status/1990.../photo/1 → asteroid_ill（不是状态页就不认） */
  function handleFromPageUrl() {
    try {
      const match = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(location.pathname ?? "");
      return match ? match[1] : "";
    } catch {
      return "";
    }
  }

  /**
   * X.com 取昵称，逐级退让、任何一级拿到就停：
   *   1) 被拖的 <img> 所在推文（引用推取最近那层）→ 作者区（显示名 → 昵称文本 → @句柄）；
   *   2) 图不在推文里（灯箱/大图查看）→ 沿祖先找只含一个作者区的那层；
   *   3) 还是不行 → 推文里 /账号/status/ 链接；
   *   4) 最后一招 → 页面地址里的账号（/<账号>/status/…/photo/1）。
   */
  function readXAuthor(image) {
    const tweet = image.closest(X_QUOTED_SELECTOR) ?? image.closest(X_TWEET_SELECTOR);
    if (tweet) {
      const fromBox = readAuthorBox(tweet.querySelector(X_AUTHOR_SELECTOR));
      if (fromBox) return fromBox;
      const fromLink = handleFromStatusLink(tweet);
      if (fromLink) return fromLink;
    }
    return authorFromAncestors(image) || handleFromPageUrl();
  }

  /** 站点适配表：只对认识的站点就近查询一次 DOM，不认识的站点不猜（宁可不加前缀） */
  const AUTHOR_ADAPTERS = [{ host: /(?:^|\.)(?:x|twitter)\.com$/i, read: readXAuthor }];

  /** 同步 DOM 查询，无网络、无异步：拿不到就返回空串，绝不拖慢拖拽 */
  function authorOf(image) {
    try {
      for (const adapter of AUTHOR_ADAPTERS) {
        if (!adapter.host.test(location.hostname)) continue;
        return cleanAuthor(adapter.read(image) ?? "");
      }
    } catch {
      // 页面结构变了 / 拿到非元素节点：安静放弃前缀，不干扰采集
    }
    return "";
  }

  let session = null;
  let overlay = null;

  /* ---------------- 与后台通信 ---------------- */

  function errorText(error) {
    if (!error) return "未知错误";
    if (typeof error === "string") return error;
    if (typeof error.message === "string" && error.message) return error.message;
    if (typeof error.code === "string" && error.code) return error.code;
    return "未知错误";
  }

  /** 发一条扩展消息；超时/取消都折成 `{ok:false, error}`，不抛未捕获异常 */
  function sendExtension(message, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, error: { code: "TIMEOUT", message: "工具箱没有响应（超时）" } });
      }, timeoutMs);
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          finish({ ok: false, error: { code: "DISCONNECTED", message: "扩展已更新，请刷新本页" } });
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            finish({
              ok: false,
              error: { code: "DISCONNECTED", message: "扩展后台没有响应，请重新加载扩展" },
            });
            return;
          }
          finish(response ?? { ok: false, error: { code: "INTERNAL", message: "扩展没有回复" } });
        });
      } catch (error) {
        finish({ ok: false, error: { code: "DISCONNECTED", message: errorText(error) } });
      }
    });
  }

  /* ---------------- 浮层 ---------------- */

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = globalThis.YSTKOverlay.create({
      loadChildren: requestChildren,
      onDrop: (relPath) => {
        submitDrop(relPath);
      },
      onDismiss: () => endSession(),
    });
    return overlay;
  }

  /** 当前会话是否还能读目录（hello 成功且目标版本未失效） */
  async function requestChildren(relPath) {
    const current = session;
    if (!current || !current.target) {
      return { entries: [], truncated: false, truncatedReason: null };
    }
    const response = await sendExtension(
      {
        type: "collector/list-children",
        payload: {
          target: {
            instanceId: current.target.instanceId,
            contextVersion: current.target.contextVersion,
          },
          relPath,
        },
      },
      LIST_TIMEOUT_MS,
    );
    if (response?.ok && response.data) return response.data;
    throw response?.error ?? { code: "INTERNAL", message: "读取子目录失败" };
  }

  /* ---------------- 原图候选 ---------------- */

  function pathOf(url) {
    const hashAt = url.indexOf("#");
    const text = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const queryAt = text.indexOf("?");
    return queryAt >= 0 ? text.slice(0, queryAt) : text;
  }

  /** 相对地址 → 绝对 http(s)；data:image 原样返回；其它协议一律不要 */
  function absoluteUrl(raw) {
    if (typeof raw !== "string") return "";
    const text = raw.trim();
    if (!text) return "";
    if (/^data:image\//i.test(text)) return text;
    try {
      const url = new URL(text, location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }

  /** 去掉末段 `@尺寸处理` 后缀；没有后缀返回空串（调用方据此区分"有没有"） */
  function stripVariant(src) {
    if (typeof src !== "string" || !src) return "";
    if (/^data:/i.test(src)) return "";
    const hashAt = src.indexOf("#");
    const noHash = hashAt >= 0 ? src.slice(0, hashAt) : src;
    const queryAt = noHash.indexOf("?");
    const query = queryAt >= 0 ? noHash.slice(queryAt) : "";
    const pathPart = queryAt >= 0 ? noHash.slice(0, queryAt) : noHash;
    const slash = pathPart.lastIndexOf("/");
    const head = pathPart.slice(0, slash + 1);
    const tail = pathPart.slice(slash + 1);
    const at = tail.indexOf("@");
    if (at <= 0) return "";
    // 尺寸类查询参数只对"变体接口"有意义，去后缀时连它一起丢；其它查询串照旧保留
    const keepQuery = query !== "" && !SIZE_QUERY_RE.test(query) ? query : "";
    return `${head}${tail.slice(0, at)}${keepQuery}`;
  }

  /**
   * X/Twitter 图片 CDN 的尺寸档：?name=small|medium|large|120x120|4096x4096 都是压缩版，
   * name=orig 才是上传的原图（时间线里那张确实被压过）。
   * format 参数保持原样优先；传 "jpg" 时另给一条 format=jpg&name=orig 作兜底。
   */
  function twimgOriginal(src, format) {
    if (typeof src !== "string" || !src) return "";
    let url;
    try {
      url = new URL(src);
    } catch {
      return "";
    }
    if (url.hostname !== "pbs.twimg.com") return "";
    const name = url.searchParams.get("name");
    if (!name || name === "orig") return "";
    url.searchParams.set("name", "orig");
    if (format) url.searchParams.set("format", format);
    return url.href;
  }

  /** srcset 里权重最大的一项：`{ url, weight }`（无描述按 1x 计，w 描述按像素宽） */
  function bestSrcsetEntry(srcset) {
    if (typeof srcset !== "string" || !srcset.trim()) return null;
    let best = null;
    for (const part of srcset.split(",")) {
      const pieces = part.trim().split(/\s+/);
      const url = pieces[0] ?? "";
      if (!url) continue;
      let weight = 1;
      for (const descriptor of pieces.slice(1)) {
        const match = /^([0-9.]+)([wx])$/i.exec(descriptor);
        if (!match) continue;
        const value = Number(match[1]);
        if (!Number.isFinite(value)) continue;
        weight = Math.max(weight, match[2].toLowerCase() === "x" ? value * 1000 : value);
      }
      if (!best || weight > best.weight) best = { url, weight };
    }
    return best;
  }

  /** `<img srcset>` 的最大项 */
  function srcsetLargest(image) {
    const entry = bestSrcsetEntry(image.srcset ?? "");
    return entry ? absoluteUrl(entry.url) : "";
  }

  /** `<picture>` 里各 `<source srcset>` 的最大项（跨 source 比权重） */
  function pictureLargest(image) {
    if (typeof image.closest !== "function") return "";
    const picture = image.closest("picture");
    if (!picture || typeof picture.querySelectorAll !== "function") return "";
    let best = null;
    for (const source of picture.querySelectorAll("source[srcset]")) {
      const entry = bestSrcsetEntry(source.getAttribute("srcset") ?? "");
      if (!entry) continue;
      if (!best || entry.weight > best.weight) best = entry;
    }
    return best ? absoluteUrl(best.url) : "";
  }

  /** 外层链接指向图片文件（灯箱/原图链接）时才算线索，避免把详情页当图片抓 */
  function anchorImageUrl(image) {
    if (typeof image.closest !== "function") return "";
    const link = image.closest("a[href]");
    if (!link) return "";
    const href = absoluteUrl(link.getAttribute("href") ?? "");
    if (!href || /^data:/i.test(href)) return "";
    return IMAGE_PATH_RE.test(pathOf(stripVariant(href) || href)) ? href : "";
  }

  /** 自定义属性里挂的原图地址（按图片扩展名过滤，避免抓到页面/统计地址） */
  function dataSrcUrl(image) {
    if (typeof image.getAttribute !== "function") return "";
    for (const attr of DATA_SRC_ATTRS) {
      const url = absoluteUrl(image.getAttribute(attr) ?? "");
      if (!url || /^data:/i.test(url)) continue;
      if (IMAGE_PATH_RE.test(pathOf(stripVariant(url) || url))) return url;
    }
    return "";
  }

  /**
   * 原图候选（按"更可能是原图"排序、去重，最多 MAX_CANDIDATES 条）：
   * 1) 渲染地址去掉 `@尺寸后缀`（B 站这类站点的唯一原图线索）；
   * 2) 外层链接指向的图片文件；
   * 3) `<img srcset>` / `<picture><source>` 的最大项；
   * 4) `data-original` 一类属性；
   * 5) 兜底：当前渲染地址（宁可存缩略图，也不能不存）。
   * 真正的取舍在后台：逐个取回后按解码像素面积挑最大的那张。
   */
  function deriveCandidates(image) {
    const rendered = absoluteUrl(image.currentSrc || image.src || "");
    const preferred = [
      // X/Twitter：?name=small 只是尺寸档，name=orig 才是原图
      twimgOriginal(rendered),
      twimgOriginal(rendered, "jpg"),
      // B 站这类 CDN：去掉末段 @尺寸后缀
      stripVariant(rendered),
      anchorImageUrl(image),
      srcsetLargest(image),
      pictureLargest(image),
      dataSrcUrl(image),
    ];
    const out = [];
    const push = (raw) => {
      const url = absoluteUrl(raw);
      if (!url || out.includes(url)) return;
      out.push(url);
    };
    // 渲染地址永远留最后一格兜底：宁可存缩略图，也不能一条都取不回来
    const limit = rendered ? MAX_CANDIDATES - 1 : MAX_CANDIDATES;
    for (const raw of preferred) {
      if (out.length >= limit) break;
      push(raw);
    }
    push(rendered);
    return out;
  }

  /* ---------------- 会话 ---------------- */

  function isSupportedSource(src) {
    if (/^https?:\/\//i.test(src)) return { ok: true, kind: "http" };
    if (/^data:image\//i.test(src)) return { ok: true, kind: "data" };
    if (/^blob:/i.test(src)) {
      return {
        ok: false,
        message: "blob: 图片本期不支持：请直接从原网页拖拽 http(s) 图片（扩展拿不到页面内存里的 blob）",
      };
    }
    return { ok: false, message: `这个图片地址本期不支持（${SUPPORTED_TITLE}）` };
  }

  /** 从拖拽事件里找到被拖的 <img>（同页顶层帧，不做跨 iframe） */
  function findDragImage(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (node && node.nodeType === 1 && node.tagName === "IMG") return node;
    }
    const target = event.target;
    if (target && target.nodeType === 1 && target.tagName === "IMG") return target;
    return null;
  }

  /** 拖动起点（viewport 坐标）：浮卡要落在「开始拖的这张图」旁边 */
  function dragOrigin(event, image) {
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    const rect = image.getBoundingClientRect();
    return { x: rect.right, y: rect.top };
  }

  function startSession(image, event) {
    // 候选按"更可能是原图"排好序：后台会逐个取回、按解码像素面积挑最大的一张
    const candidates = deriveCandidates(image);
    const src = candidates[0] ?? "";
    if (!src) return;
    if (session) endSession();

    const supported = isSupportedSource(src);
    session = {
      src,
      candidates,
      origin: dragOrigin(event, image),
      sourceKind: supported.kind ?? "http",
      alt: image.alt || "",
      // 作者昵称只做文件名前缀：站点没适配/结构对不上就是空串，不影响采集
      author: authorOf(image),
      pageUrl: location.href,
      pageTitle: document.title,
      target: null,
      ready: false,
      saving: false,
      dropped: false,
      revalidateTimer: null,
    };
    void connectSession(session, supported);
  }

  async function connectSession(current, supported) {
    const panel = ensureOverlay();

    if (!supported.ok) {
      panel.open({
        anchor: current.origin,
        author: current.author,
        displayPath: "参考图库",
        baseRelPath: "",
        theme: "light",
        mode: "notice",
      });
      panel.setLocked(supported.message);
      return;
    }

    const hello = await sendExtension({ type: "collector/hello" }, HELLO_TIMEOUT_MS);
    if (session !== current) return;

    if (!hello?.ok) {
      panel.open({
        anchor: current.origin,
        author: current.author,
        displayPath: "参考图库",
        baseRelPath: "",
        theme: "light",
        mode: "notice",
      });
      panel.setLocked(connectHint(hello?.error));
      return;
    }

    const data = hello.data ?? {};
    if (data.enabled === false) {
      panel.open({
        anchor: current.origin,
        author: current.author,
        displayPath: "参考图库",
        baseRelPath: "",
        theme: "light",
        mode: "notice",
      });
      panel.setLocked("采集已关闭：点浏览器工具栏上的扩展图标，打开「采集开关」再拖图。");
      return;
    }
    if (!data.connected || !data.target) {
      panel.open({
        anchor: current.origin,
        author: current.author,
        displayPath: "参考图库",
        baseRelPath: "",
        theme: "light",
        mode: "notice",
      });
      panel.setLocked(connectHint(data.blocked));
      return;
    }
    // 上一张还在保存不再挡人：后台按队列串行取图/写盘（队列满才回 BUSY），
    // 松手即关窗，用户连续拖几张也不会丢图。
    if (data.blocked) {
      panel.open({
        anchor: current.origin,
        author: current.author,
        displayPath: data.target.displayPath ?? "参考图库",
        baseRelPath: data.target.baseRelPath ?? "",
        theme: data.target.theme,
        // 有目标但此刻不能投（权限/跨库/未就绪）：只弹提示卡，不画投放范围
        mode: "notice",
      });
      panel.setLocked(errorText(data.blocked));
      return;
    }

    current.target = data.target;
    current.ready = true;
    panel.open({
      anchor: current.origin,
      author: current.author,
      displayPath: data.target.displayPath ?? "参考图库",
      baseRelPath: data.target.baseRelPath ?? "",
      theme: data.target.theme,
      // 真能投：虚线投放区 / 点线悬停区的范围标注都出来
      mode: "collect",
    });
    panel.setLocked(null);
    startRevalidate(current);
  }

  function connectHint(error) {
    const code = error?.code;
    if (code === "MULTIPLE_TABS") {
      return "打开了多个工具箱页面：请在扩展弹窗里选定一个接收端再拖图。";
    }
    if (code === "NO_RECEIVER") {
      return "没有连上工具箱：请在同浏览器的工具箱 /library 页面打开并授权参考图库，再拖一次。";
    }
    if (code === "TIMEOUT") {
      return "工具箱没有响应：确认 /library 页面仍开着，再拖一次。";
    }
    return `无法连接工具箱：${errorText(error)}`;
  }

  /** 拖图期间轻量复查目标版本；变了就作废旧浮层，不悄悄换目标 */
  function startRevalidate(current) {
    stopRevalidate();
    current.revalidateTimer = setInterval(async () => {
      if (session !== current || !current.ready || current.saving) return;
      const hello = await sendExtension({ type: "collector/hello" }, HELLO_TIMEOUT_MS);
      if (session !== current) return;
      if (!hello?.ok || !hello.data?.target) {
        current.ready = false;
        stopRevalidate();
        ensureOverlay().invalidate();
        return;
      }
      if (hello.data.target.contextVersion !== current.target.contextVersion) {
        current.ready = false;
        stopRevalidate();
        ensureOverlay().invalidate();
      }
    }, REVALIDATE_MS);
  }

  function stopRevalidate() {
    if (session?.revalidateTimer) {
      clearInterval(session.revalidateTimer);
      session.revalidateTimer = null;
    }
  }

  function endSession() {
    if (session) {
      stopRevalidate();
      session = null;
    }
    if (overlay && overlay.isOpen()) overlay.close();
  }

  /**
   * 松手：**只提交一次，然后立刻关窗**（2026-11-18 用户口径：松手即消失）。
   * 取图与写盘交给后台队列，结果看扩展弹窗里的「上一次采集」。
   *
   * `dropped` 是"这次拖拽已经用掉"的闸：浮层关掉、session 置空后，
   * 残留的 drop / 重复的 drop 都不可能再存第二张——一次拖拽只落一个文件。
   */
  function submitDrop(relPath) {
    const current = session;
    if (!current || current.dropped || current.saving || !current.ready) return;
    current.dropped = true;
    current.saving = true;
    const payload = {
      relPath,
      src: current.src,
      candidates: current.candidates,
      sourceKind: current.sourceKind,
      pageUrl: current.pageUrl,
      pageTitle: current.pageTitle,
      alt: current.alt,
      author: current.author,
      target: {
        instanceId: current.target.instanceId,
        contextVersion: current.target.contextVersion,
      },
    };
    // 先关窗（同步），再发消息：网络/写盘都在后台继续，不等用户按 Esc
    endSession();
    void sendSave(payload);
  }

  async function sendSave(payload) {
    const response = await sendExtension({ type: "collector/save", payload }, SAVE_TIMEOUT_MS);
    if (response?.ok) {
      const saved = response.data ?? {};
      console.info(
        `[ystk-collector] 已保存 ${saved.relPath ?? ""}（${saved.bytes ?? 0} 字节）`,
      );
      return;
    }
    const error = response?.error ?? {};
    console.warn(`[ystk-collector] 保存失败：${describeSaveError(error)}`, error);
  }

  function describeSaveError(error) {
    switch (error?.code) {
      case "STALE_TARGET":
        return "工具箱的浏览目录在保存过程中变了，这次没有写文件；请重新拖一次。";
      case "PERMISSION_LOST":
        return "图库目录权限已失效：回到工具箱按现有流程重新授权后再拖。";
      case "CROSS_SEARCH":
        return "工具箱正开着跨库搜索，无法确定保存目录；先关掉跨库搜索再拖。";
      case "BUSY":
        return "后台保存队列已满（最多 6 张），这次没有写文件；稍等几秒再拖。";
      case "DUPLICATE":
        return "这张图这次拖拽已经在保存，重复提交已忽略（不会写第二份）。";
      case "DIR_MISSING":
        return "目标子目录已不存在（不会自动重建，也不会退回根目录）。";
      case "TOO_LARGE":
        return "图片超过 32 MiB 限额，未保存。";
      case "INVALID_IMAGE":
        return "拿到的不是有效图片（可能是登录页/防盗链页面），未保存。";
      case "FETCH_FAILED":
        return "抓取图片失败（登录或防盗链拦住了）；扩展不会带 cookie 或伪造 Referer。";
      case "CANCEL_SAVE":
        return "保存已取消，缓冲区已清理。";
      case "TIMEOUT":
        return "结果未确认，请检查目标目录后再决定是否重拖（不会自动重试）。";
      case "MULTIPLE_TABS":
        return "有多个工具箱页面，请先在扩展弹窗里选定接收端。";
      case "NO_RECEIVER":
        return "工具箱页面已关闭或失联；重新打开 /library 再拖一次。";
      default:
        return errorText(error);
    }
  }

  /* ---------------- 事件接线 ---------------- */

  window.addEventListener(
    "dragstart",
    (event) => {
      if (!event.isTrusted) return;
      const image = findDragImage(event);
      if (!image) return;
      startSession(image, event);
    },
    true,
  );

  // 松开在框外 / 拖拽被取消：收起浮层，取消未提交的采集（已提交的不动）
  window.addEventListener(
    "dragend",
    () => {
      if (!session) return;
      if (session.saving) return;
      endSession();
    },
    true,
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      if (!session || session.saving) return;
      endSession();
    },
    true,
  );

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "collector/target-changed") return;
    if (!session || session.saving) return;
    session.ready = false;
    stopRevalidate();
    ensureOverlay().invalidate();
  });

  // 原图候选推导是纯函数；导出给构建期/自测脚本直接核对 URL 规则（同 overlay 导出 COMPONENT_CSS 的口径）
  globalThis.YSTKCollectorSrc = { deriveCandidates, stripVariant, bestSrcsetEntry, twimgOriginal };
  // 作者昵称适配（X.com）同样是纯函数 + 一次同步 DOM 查询，导出给自测脚本喂假 DOM 核对
  globalThis.YSTKCollectorAuthor = {
    authorOf,
    readXAuthor,
    cleanAuthor,
    nameFromText,
    handleFrom,
    handleFromPageUrl,
  };
})();
