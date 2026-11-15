"use strict";
/**
 * 原摄工具箱 · 工具箱页面专用桥接（隔离世界 content script）
 *
 * 只在工具箱地址（manifest 白名单）启用，起「扩展后台 ⇄ 页面」的转接作用：
 *   后台 → 本脚本 → `window.postMessage({__ystk:"toolkit-in"})` → 页面 collector/bridge.ts
 *   页面 → `window.postMessage({__ystk:"toolkit-out"})` → 本脚本 → 后台
 *
 * 安全纪律（任务卡 §4.3）：只转发带本协议命名空间、且 requestId 能对上的信封；
 * 宿主页面其它 postMessage 一律不转发；发往页面时 targetOrigin 精确到 location.origin。
 */
(() => {
  if (globalThis.YSTK_TOOLKIT_BRIDGE_READY) return;
  globalThis.YSTK_TOOLKIT_BRIDGE_READY = true;

  const PROTOCOL_NS = "ystk-collector";
  const PROTOCOL_VERSION = 1;
  const INBOUND_MARK = "toolkit-in";
  const OUTBOUND_MARK = "toolkit-out";
  /** 页面可能还没挂载完（content script 在 document_start 就跑）：没回应就重发 */
  const REPOST_MS = 500;
  const ORIGIN = window.location.origin;

  /** requestId → 等待中的转发 */
  const pending = new Map();

  window.addEventListener("message", (event) => {
    // 只接受本窗口、本源的页面回复
    if (event.source !== window) return;
    if (event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.__ystk !== OUTBOUND_MARK) return;
    const envelope = data.envelope;
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.ns !== PROTOCOL_NS || envelope.v !== PROTOCOL_VERSION) return;

    if (envelope.kind === "response") {
      const waiting = pending.get(envelope.requestId);
      if (!waiting) return;
      clearInterval(waiting.repost);
      clearTimeout(waiting.timer);
      pending.delete(envelope.requestId);
      waiting.resolve(envelope);
      return;
    }
    if (envelope.kind === "event" && envelope.type === "TARGET_CHANGED") {
      try {
        chrome.runtime.sendMessage({ type: "toolkit/event", payload: envelope });
      } catch {
        // 扩展被重载/卸载时静默吞掉，页面本身不受影响
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "toolkit/request") return undefined;
    // 只信自己扩展的后台（普通网页与其它扩展无法走到这里）
    if (!sender || sender.id !== chrome.runtime.id) return undefined;
    const envelope = message.envelope;
    if (!envelope || envelope.ns !== PROTOCOL_NS) {
      sendResponse({ ok: false, error: { code: "BAD_REQUEST", message: "协议不匹配" } });
      return undefined;
    }
    forward(envelope, Number(message.timeoutMs) || 3000).then(sendResponse);
    return true; // 异步回执
  });

  function forward(envelope, timeoutMs) {
    return new Promise((resolve) => {
      const existing = pending.get(envelope.requestId);
      if (existing) {
        clearInterval(existing.repost);
        clearTimeout(existing.timer);
        pending.delete(envelope.requestId);
      }
      const post = () => {
        window.postMessage({ __ystk: INBOUND_MARK, envelope }, ORIGIN);
      };
      const timer = setTimeout(() => {
        const waiting = pending.get(envelope.requestId);
        if (waiting) {
          clearInterval(waiting.repost);
          pending.delete(envelope.requestId);
        }
        resolve({ ok: false, error: { code: "TIMEOUT", message: "工具箱页面没有回应" } });
      }, timeoutMs);
      const repost = setInterval(post, REPOST_MS);
      pending.set(envelope.requestId, { resolve, timer, repost });
      post();
    });
  }
})();
