"use strict";
/**
 * 采集弹窗：选接收端、开关采集、看最近任务。
 *
 * 数据全部来自后台（`popup/*` 消息）；这里不直连工具箱页面，
 * 也不缓存目录状态——切图库/改目录都由后台重新握手取得。
 */
(() => {
  const els = {
    enabled: document.getElementById("enabled"),
    receiver: document.getElementById("receiver"),
    candidates: document.getElementById("candidates"),
    lastTask: document.getElementById("last-task"),
    refresh: document.getElementById("refresh"),
  };

  /** 原始 token CSS 注入（popup 是扩展页面，不需要 Shadow DOM 改写选择器） */
  function injectTokens() {
    const tokens = globalThis.YSTK_TOKENS;
    if (!tokens || typeof tokens.css !== "string") return;
    const style = document.createElement("style");
    style.textContent = tokens.css;
    document.head.prepend(style);
  }

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: { code: "INTERNAL", message: chrome.runtime.lastError.message } });
          return;
        }
        resolve(response ?? { ok: false, error: { code: "INTERNAL", message: "后台没有回复" } });
      });
    });
  }

  function textOf(element, text) {
    if (element) element.textContent = text;
  }

  function themeOf(data) {
    const theme = data?.receiver?.theme ?? data?.candidates?.[0]?.theme ?? "light";
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  }

  function renderReceiver(data) {
    if (data.receiver) {
      const ready = data.receiver.ready ? "" : "（未就绪）";
      const path = data.receiver.displayPath || "参考图库";
      textOf(els.receiver, `已选定：${path}${ready}`);
      els.receiver.className = data.receiver.ready ? "hint ok" : "hint";
      return;
    }
    if (data.candidates.length === 0) {
      textOf(
        els.receiver,
        "没有找到工具箱页面：请在同一浏览器打开工具箱的 /library 页并授权参考图库。",
      );
      els.receiver.className = "hint err";
      return;
    }
    textOf(els.receiver, "有多个工具箱页面：请选一个接收端（未选不猜、不群发）。");
    els.receiver.className = "hint err";
  }

  function renderCandidates(data) {
    els.candidates.replaceChildren();
    const selectedTabId = data.receiver?.tabId ?? null;
    for (const candidate of data.candidates) {
      const item = document.createElement("li");
      item.className = "row";
      if (candidate.tabId === selectedTabId) item.classList.add("is-selected");

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "receiver";
      input.value = String(candidate.tabId);
      input.id = `receiver-${candidate.tabId}`;
      input.checked = candidate.tabId === selectedTabId;
      input.addEventListener("change", () => {
        void selectReceiver(candidate.tabId);
      });

      const label = document.createElement("label");
      label.className = "row-label";
      label.htmlFor = input.id;

      const path = document.createElement("span");
      path.className = "row-path";
      path.textContent = candidate.displayPath || "参考图库";

      const meta = document.createElement("span");
      meta.className = "row-meta";
      const url = candidate.url || "";
      meta.textContent = candidate.ready ? url : `${url}（未就绪）`;

      label.append(path, meta);
      item.append(input, label);
      els.candidates.append(item);
    }
  }

  function renderLastTask(data) {
    const task = data.lastTask;
    // 松手即关浮层后，后台队列是唯一的进度出口：有排队就顺带说一句
    const queueSuffix = data.queued > 0 ? `（后台队列 ${data.queued} 张）` : "";
    if (!task || !task.status) {
      textOf(els.lastTask, `还没有采集记录。${queueSuffix}`);
      els.lastTask.className = "hint";
      return;
    }
    const when = task.at ? new Date(task.at).toLocaleTimeString() : "";
    if (task.status === "saving") {
      textOf(els.lastTask, `保存中…（${when}）${queueSuffix}`);
      els.lastTask.className = "hint";
      return;
    }
    if (task.status === "saved") {
      textOf(els.lastTask, `已保存：${task.relPath ?? task.fileName ?? ""}（${when}）${queueSuffix}`);
      els.lastTask.className = "hint ok";
      return;
    }
    if (task.status === "unconfirmed") {
      textOf(els.lastTask, `结果未确认：请检查目标目录（${when}）${queueSuffix}`);
      els.lastTask.className = "hint err";
      return;
    }
    textOf(
      els.lastTask,
      `失败：${task.error?.message ?? "未知原因"}${when ? `（${when}）` : ""}${queueSuffix}`,
    );
    els.lastTask.className = "hint err";
  }

  function render(response) {
    const data = response?.ok ? response.data : null;
    if (!data) {
      textOf(els.receiver, `读取状态失败：${response?.error?.message ?? "未知错误"}`);
      els.receiver.className = "hint err";
      return;
    }
    themeOf(data);
    if (els.enabled) els.enabled.checked = data.enabled !== false;
    renderReceiver(data);
    renderCandidates(data);
    renderLastTask(data);
  }

  async function refresh() {
    render(await send({ type: "popup/state" }));
  }

  async function selectReceiver(tabId) {
    render(await send({ type: "popup/select", payload: { tabId } }));
  }

  async function toggleEnabled(enabled) {
    render(await send({ type: "popup/set-enabled", payload: { enabled } }));
  }

  els.enabled?.addEventListener("change", () => {
    void toggleEnabled(Boolean(els.enabled.checked));
  });
  els.refresh?.addEventListener("click", () => {
    void refresh();
  });

  injectTokens();
  void refresh();
  // 后台可能在保存：弹窗开着时轻量刷新一次状态（不轮询图片数据）
  setInterval(() => {
    void refresh();
  }, 4000);
})();
