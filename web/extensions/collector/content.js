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
  /** 工具箱侧整次保存上限 60s，这里留 5s 余量，只做兜底不抢先误报 */
  const SAVE_TIMEOUT_MS = 65000;
  const REVALIDATE_MS = 5000;

  const SUPPORTED_TITLE = "仅支持 http(s) 图片与小于限额的 data:image";

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
        void saveTo(relPath);
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
    const src = (image.currentSrc || image.src || "").trim();
    if (!src) return;
    if (session) endSession();

    const supported = isSupportedSource(src);
    session = {
      src,
      origin: dragOrigin(event, image),
      sourceKind: supported.kind ?? "http",
      alt: image.alt || "",
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
        displayPath: "参考图库",
        baseRelPath: "",
        theme: "light",
        mode: "notice",
      });
      panel.setLocked(connectHint(data.blocked));
      return;
    }
    if (data.busy) {
      panel.open({
        anchor: current.origin,
        displayPath: "参考图库",
        baseRelPath: "",
        theme: "light",
        mode: "notice",
      });
      panel.setLocked("上一张还在保存，请等它完成后再拖这一张（不会静默丢图）。");
      return;
    }
    if (data.blocked) {
      panel.open({
        anchor: current.origin,
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

  async function saveTo(relPath) {
    const current = session;
    if (!current || current.saving || !current.ready) return;
    current.saving = true;
    current.dropped = true;
    const panel = ensureOverlay();
    panel.setStatus("saving", "保存中…");
    panel.setLocked("保存中，请稍候…");

    const response = await sendExtension(
      {
        type: "collector/save",
        payload: {
          relPath,
          src: current.src,
          sourceKind: current.sourceKind,
          pageUrl: current.pageUrl,
          pageTitle: current.pageTitle,
          alt: current.alt,
          target: {
            instanceId: current.target.instanceId,
            contextVersion: current.target.contextVersion,
          },
        },
      },
      SAVE_TIMEOUT_MS,
    );

    current.saving = false;
    if (session !== current) return;

    if (response?.ok && response.data) {
      panel.setLocked(null);
      panel.setStatus(
        "ok",
        `已保存到 ${response.data.relPath}；回到工具箱点「重新扫描」后显示。`,
      );
      return;
    }

    const error = response?.error ?? {};
    panel.setLocked(null);
    panel.setStatus("error", `保存失败：${describeSaveError(error)}`);
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
        return "工具箱正忙（上一张还在保存），这次没有写文件。";
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
})();
