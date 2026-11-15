"use strict";
/**
 * 原摄工具箱 · 拖拽采集浮层（Shadow DOM 视图层）
 *
 * 只做三件事：画浮卡、管目录导航、把「拖到哪个目录松手」交给回调。
 * 不取图、不写文件、不发扩展消息——那些在 content.js / background.js。
 *
 * 形态（2026-11-13 定）：Eagle 式浮卡，落在「开始拖的那张图」旁边，
 * 不压暗整页、不盘在角落。左栏是当前目录的大虚线投放区，右栏是子目录列表；
 * 虚线框 = 松手即保存，点线框 = 悬停 0.5 秒进入下级 / 返回上级。
 *
 * 样式纪律（任务卡 §4.2）：颜色只来自 tokens.js 的 CSS 文本（从主项目
 * styles/tokens.css 生成），本文件禁止出现硬编码色值。
 * ⚠️ 选择器改写必须补齐括号：`[data-theme="x"]` → `:host([data-theme="x"])`。
 * 少一个 `)` 会让 CSS 解析器一路吞到文件尾，后面整张样式表（含本文件的
 * 全部布局规则）被丢弃，浮层退化成「无样式纯文字贴在网页上」。
 * web/scripts/build-collector.mjs 的样式自检会拦住这种写法。
 */
(() => {
  if (globalThis.YSTKOverlay) return;

  const HOST_TAG = "ystk-collector-overlay";
  /** 「展开下级」「返回上级」的悬停驻留时间（任务卡 §4.2：500ms） */
  const HOVER_DWELL_MS = 500;
  /** 浮卡与拖动起点的间距 / 与视口边缘的最小留白（px） */
  const ANCHOR_GAP = 18;
  const VIEWPORT_MARGIN = 12;
  const SVG_NS = "http://www.w3.org/2000/svg";
  /** 底栏一行图例：不写颜色名（深浅主题 accent 不同色），只说框型对应什么动作 */
  const LEGEND_TEXT =
    "虚线框内松手 = 保存 · 点线框悬停 0.5 秒 = 进入下级 / 返回上级 · 松手即落盘，回工具箱点「重新扫描」才显示";

  /* ---------------- tokens → Shadow DOM ---------------- */

  /**
   * 主项目 tokens.css 用 `:root` / `[data-theme="x"]` 选择器；
   * 进入 Shadow DOM 后根是宿主元素，故改写成 `:host` / `:host([data-theme="x"])`。
   * 注意 `[data-theme=]` 那条**必须**把 `)` 补回去：括号不闭合会把整张表吞掉。
   * @supports 块原样保留（只换选择器，不动声明）。
   */
  function toHostCss(rawCss) {
    return rawCss
      .replace(/:root/g, ":host")
      .replace(/(^|[\s,{}>])\[data-theme=("[^"]*")\]/g, "$1:host([data-theme=$2])");
  }

  const COMPONENT_CSS = `
    :host {
      display: block;
      margin: 0;
      padding: 0;
      border: 0;
      font-family: var(--font-ui);
    }
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    /* 浮卡：Eagle 式两栏卡片。left/top 由 placeCard() 写入（贴着拖动起点），
       先落在 -9999px 量完尺寸再落位，避免首帧跳一下。
       宿主铺满视口但 pointer-events: none，只有 .card 吃事件，网页原有
       拖拽/点击不受影响（任务卡 §4.2）。 */
    .card {
      position: fixed;
      left: -9999px;
      top: -9999px;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      width: min(720px, calc(100vw - 24px));
      max-height: min(560px, calc(100vh - 24px));
      padding: var(--space-3);
      border: 1px solid var(--line);
      border-radius: var(--radius-xl);
      background: var(--bg-elevated);
      -webkit-backdrop-filter: var(--glass-blur);
      backdrop-filter: var(--glass-blur);
      box-shadow: var(--shadow-float);
      color: var(--text-1);
      font-family: var(--font-ui);
      font-size: var(--text-md);
      line-height: 1.45;
      overflow: hidden;
      pointer-events: auto;
      animation: card-in var(--motion-base) both;
    }
    @keyframes card-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    .card-head {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      min-width: 0;
    }
    .crumb {
      flex: 1 1 auto;
      min-width: 0;
    }
    .crumb-lib {
      font-size: var(--text-xs);
      color: var(--text-3);
    }
    .crumb-path {
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--text-1);
      word-break: break-all;
    }
    .head-actions {
      display: flex;
      flex: 0 0 auto;
      gap: var(--space-1);
    }
    .ghost {
      font: inherit;
      font-size: var(--text-xs);
      color: var(--text-2);
      background: var(--bg-glass-soft);
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      padding: var(--space-1) var(--space-2);
      cursor: pointer;
      white-space: nowrap;
    }
    .ghost:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .ghost:focus-visible,
    .row-expand:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    /* 两栏主体：左 = 当前目录的大投放区，右 = 子目录列表 */
    .card-main {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
      gap: var(--space-3);
      flex: 1 1 auto;
      min-height: min(300px, 42vh);
      min-width: 0;
    }
    .drop-current {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      padding: var(--space-5);
      text-align: center;
      border: 1px dashed var(--line);
      border-radius: var(--radius-lg);
      background: var(--bg-glass-soft);
      min-width: 0;
    }
    .zone-icon {
      width: 48px;
      height: 48px;
      flex: 0 0 auto;
      color: var(--text-3);
    }
    .zone-label {
      font-size: var(--text-sm);
      color: var(--text-2);
    }
    .zone-name {
      max-width: 100%;
      font-size: var(--text-lg);
      font-weight: 700;
      color: var(--text-1);
      word-break: break-all;
    }
    .zone-path {
      max-width: 100%;
      font-size: var(--text-xs);
      color: var(--text-3);
      word-break: break-all;
    }
    .side {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-width: 0;
      min-height: 0;
    }
    .list-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .list-head .title {
      font-size: var(--text-xs);
      color: var(--text-3);
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      /* 窗高由 .card 的 max-height 决定，列表吃掉剩余高度并自己滚 */
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding-right: 2px;
    }
    .row {
      display: flex;
      align-items: stretch;
      gap: var(--space-1);
      border: 1px dashed var(--line);
      border-radius: var(--radius-md);
      background: var(--bg-glass-soft);
      overflow: hidden;
    }
    .row.is-over {
      border-color: var(--accent);
      border-style: solid;
      background: var(--accent-weak);
    }
    .row.is-locked {
      opacity: 0.5;
    }
    .row-name {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      padding: var(--space-2);
      font-size: var(--text-sm);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-expand {
      flex: 0 0 auto;
      font: inherit;
      font-size: var(--text-xs);
      color: var(--text-2);
      background: transparent;
      border: 0;
      border-left: 1px solid var(--line);
      padding: 0 var(--space-2);
      cursor: pointer;
      white-space: nowrap;
    }
    .row-expand.is-armed {
      background: var(--accent-weak);
      color: var(--accent);
    }
    .row-expand:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .empty {
      padding: var(--space-2);
      font-size: var(--text-xs);
      color: var(--text-3);
    }
    .note {
      font-size: var(--text-xs);
      color: var(--text-3);
    }
    /* ---- 拖动响应范围标注 ----------------------------------------------------
       投放区（当前目录的大块 / 每一行子目录）= 虚线框：拖进来松手即保存；
       悬停区（展开下级 / 返回上级）= 点线框：停 0.5 秒生效，松手仍落到本行。
       只在 collect 模式且未锁定（能真投）时画；锁定（保存中/目标已变/被拦）
       时全部撤掉，避免"标着能投其实不能投"。颜色只取 --accent。 */
    .drop-current,
    .row {
      position: relative;
    }
    :host([data-mode="collect"]):not([data-locked="true"]) .drop-current,
    :host([data-mode="collect"]):not([data-locked="true"]) .row {
      border-color: transparent;
    }
    :host([data-mode="collect"]):not([data-locked="true"]) .drop-current::after,
    :host([data-mode="collect"]):not([data-locked="true"]) .row::after {
      content: "";
      position: absolute;
      inset: 0;
      border: 1px dashed var(--accent);
      border-radius: inherit;
      opacity: 0.55;
      pointer-events: none;
    }
    :host([data-mode="collect"]):not([data-locked="true"]) .drop-current.is-over::after,
    :host([data-mode="collect"]):not([data-locked="true"]) .row.is-over::after {
      border-style: solid;
      opacity: 1;
    }
    :host([data-mode="collect"]):not([data-locked="true"]) .is-hover-range {
      outline: 1px dotted var(--accent);
      outline-offset: -3px;
    }
    .range-tag {
      position: absolute;
      top: var(--space-2);
      right: var(--space-2);
      padding: 0 var(--space-1);
      border-radius: var(--radius-sm);
      background: var(--accent);
      color: var(--on-accent);
      font-size: var(--text-xs);
      line-height: 1.6;
    }
    :host([data-mode="notice"]) .range-tag,
    :host([data-locked="true"]) .range-tag {
      display: none;
    }
    .card-foot {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      min-width: 0;
    }
    .status {
      min-height: 1.2em;
      font-size: var(--text-xs);
      color: var(--text-2);
      word-break: break-word;
    }
    .status[data-kind="ok"] {
      color: var(--success);
    }
    .status[data-kind="error"],
    .status[data-kind="blocked"] {
      color: var(--danger);
    }
    .legend {
      font-size: var(--text-xs);
      color: var(--text-3);
      word-break: break-word;
    }
    :host([data-mode="notice"]) .legend {
      display: none;
    }
  `;

  /* ---------------- 小工具 ---------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  /** 文件夹图标（纯装饰，颜色走 currentColor，避免硬编码色值） */
  function folderIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "zone-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.6");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute(
      "d",
      "M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.8 2.2h8.2A1.5 1.5 0 0 1 20 9.7v8.8A1.5 1.5 0 0 1 18.5 20h-14A1.5 1.5 0 0 1 3 18.5z",
    );
    svg.append(path);
    return svg;
  }

  function joinRel(base, segments) {
    return [base, ...segments].filter((part) => part && part.length > 0).join("/");
  }

  function errorText(error) {
    if (!error) return "未知错误";
    if (typeof error === "string") return error;
    const message = typeof error.message === "string" ? error.message : "";
    if (message) return message;
    const code = typeof error.code === "string" ? error.code : "";
    return code || "未知错误";
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /** 只接受有限数值的起点；脏数据一律退化成「居中兜底」，不抛异常 */
  function normalizeAnchor(raw) {
    const x = Number(raw?.x);
    const y = Number(raw?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  /** dragleave 的 relatedTarget 仍在元素内 → 不算真的离开（避免高亮闪烁） */
  function leftElement(node, event) {
    const next = event.relatedTarget;
    if (!next) return true;
    return !node.contains(next);
  }

  /* ---------------- 浮层实例 ---------------- */

  /**
   * @param {{
   *   loadChildren: (relPath: string) => Promise<{entries: {name: string, relPath: string}[], truncated: boolean, truncatedReason: string | null}>,
   *   onDrop: (relPath: string) => void,
   *   onDismiss: () => void,
   * }} handlers
   */
  function create(handlers) {
    let host = null;
    let ui = null;
    let opened = false;

    /** 本次浏览的起始目录（工具箱当前 folderScope），不允许导航到它之上 */
    let baseRel = "";
    let displayPath = "";
    let stack = [];

    /** 拖动起点（viewport 坐标）；浮卡就近落在它旁边，null 时居中兜底 */
    let anchor = null;

    let lockedMessage = null;
    let statusKind = "idle";
    let statusText = "";
    let hoverNode = null;
    let expandTimer = null;
    let expandArmedRel = null;
    let backTimer = null;

    /* ---- 骨架 ---- */

    function buildHost() {
      host = document.createElement(HOST_TAG);
      host.setAttribute("data-theme", "light");
      host.setAttribute("data-mode", "collect");
      host.setAttribute("data-locked", "false");
      host.setAttribute("role", "dialog");
      host.setAttribute("aria-label", "保存图片到原摄工具箱");
      // 内联样式压过网页对通用元素的规则：宿主铺满视口但不吃事件，
      // 只有 shadow 里的 .card 是 pointer-events:auto
      host.style.cssText = [
        "position: fixed",
        "inset: 0",
        "z-index: 2147483647",
        "display: block",
        "pointer-events: none",
      ].join(";");

      const shadow = host.attachShadow({ mode: "closed" });
      // token 表与布局表分开注入：万一 token 文本坏掉最多丢配色，
      // 布局不会跟着一起死（2026-11-13 括号 bug 的教训）
      const tokenStyle = el("style");
      const tokens = globalThis.YSTK_TOKENS;
      if (tokens && typeof tokens.css === "string") {
        tokenStyle.textContent = toHostCss(tokens.css);
      }
      const componentStyle = el("style");
      componentStyle.textContent = COMPONENT_CSS;

      const card = el("div", "card");

      const head = el("div", "card-head");
      const crumb = el("div", "crumb");
      const crumbLib = el("div", "crumb-lib");
      const crumbPath = el("div", "crumb-path");
      crumb.append(crumbLib, crumbPath);
      const headActions = el("div", "head-actions");
      const backButton = el("button", "ghost is-hover-range", "返回上级");
      backButton.type = "button";
      backButton.title = "点一下，或拖图悬停 0.5 秒：返回上级目录";
      const closeButton = el("button", "ghost", "收起");
      closeButton.type = "button";
      headActions.append(backButton, closeButton);
      head.append(crumb, headActions);

      // 左栏：Eagle 那种大块投放区（当前目录）
      const currentZone = el("div", "zone drop-current");
      const currentTag = el("span", "range-tag", "投放区");
      const zoneLabel = el("div", "zone-label", "松开保存到当前目录");
      const zoneName = el("div", "zone-name");
      const zonePath = el("div", "zone-path");
      currentZone.append(currentTag, folderIcon(), zoneLabel, zoneName, zonePath);

      // 右栏：子目录列表（每行也是投放区，右侧「展开下级」是悬停区）
      const side = el("div", "side");
      const listHead = el("div", "list-head");
      const listTitle = el("div", "title", "子目录");
      const listNote = el("div", "note", "");
      listHead.append(listTitle, listNote);
      const list = el("div", "list");
      side.append(listHead, list);

      const main = el("div", "card-main");
      main.append(currentZone, side);

      const foot = el("div", "card-foot");
      const status = el("div", "status");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const legend = el("div", "legend", LEGEND_TEXT);
      legend.setAttribute("role", "note");
      foot.append(status, legend);

      card.append(head, main, foot);
      shadow.append(tokenStyle, componentStyle, card);

      ui = {
        card,
        crumbLib,
        crumbPath,
        backButton,
        closeButton,
        status,
        legend,
        currentZone,
        currentTag,
        zoneLabel,
        zoneName,
        zonePath,
        listNote,
        list,
      };

      closeButton.addEventListener("click", () => handlers.onDismiss());
      backButton.addEventListener("click", navigateUp);
      // 面包屑/返回：拖图悬停 500ms 也能返回上一级（任务卡 §4.2）
      backButton.addEventListener("dragover", (event) => {
        if (lockedMessage || stack.length === 0) return;
        event.preventDefault();
        if (backTimer !== null) return;
        backTimer = setTimeout(() => {
          backTimer = null;
          navigateUp();
        }, HOVER_DWELL_MS);
      });
      backButton.addEventListener("dragleave", (event) => {
        if (leftElement(backButton, event)) clearBackTimer();
      });
      wireDirectoryDrop(currentZone, () => currentRelPath());

      // 卡片空白处也吃掉默认行为，避免在框内空白松手时浏览器直接打开图片
      card.addEventListener("dragover", (event) => {
        event.preventDefault();
      });
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearHover();
        handlers.onDismiss();
      });
    }

    /* ---- 定位：落在拖动起点旁边 ---- */

    /**
     * 把浮卡放到拖动起点旁边：右下优先，放不下就翻到左/上，最后夹进视口。
     * 位置在本次拖动期间固定不动（不跟鼠标），保证投放目标不跑。
     */
    function placeCard() {
      if (!ui || !ui.card.isConnected) return;
      const card = ui.card;
      // 先量尺寸（此时还在 -9999px 处，量完再落位，避免首帧跳动）
      const rect = card.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const maxLeft = Math.max(VIEWPORT_MARGIN, vw - rect.width - VIEWPORT_MARGIN);
      const maxTop = Math.max(VIEWPORT_MARGIN, vh - rect.height - VIEWPORT_MARGIN);

      let left;
      let top;
      if (anchor) {
        left = anchor.x + ANCHOR_GAP;
        top = anchor.y + ANCHOR_GAP;
        // 右边/下边放不下 → 翻到拖动起点的另一侧
        if (left > maxLeft) left = anchor.x - ANCHOR_GAP - rect.width;
        if (top > maxTop) top = anchor.y - ANCHOR_GAP - rect.height;
      } else {
        left = (vw - rect.width) / 2;
        top = vh * 0.11;
      }
      card.style.left = `${Math.round(clamp(left, VIEWPORT_MARGIN, maxLeft))}px`;
      card.style.top = `${Math.round(clamp(top, VIEWPORT_MARGIN, maxTop))}px`;
    }

    function handleViewportChange() {
      placeCard();
    }

    /* ---- 投放区通用接线 ---- */

    /** 给元素接上「投放 + 高亮」，relPath 在松手时求值（导航后语义仍正确） */
    function wireDirectoryDrop(node, resolveRelPath) {
      node.addEventListener("dragenter", (event) => {
        if (lockedMessage) return;
        event.preventDefault();
        setHover(node, resolveRelPath());
      });
      node.addEventListener("dragover", (event) => {
        if (lockedMessage) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        if (hoverNode !== node) setHover(node, resolveRelPath());
      });
      node.addEventListener("dragleave", (event) => {
        if (leftElement(node, event)) clearHover();
      });
      node.addEventListener("drop", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const relPath = resolveRelPath();
        clearHover();
        clearExpandArm();
        if (lockedMessage) return;
        handlers.onDrop(relPath);
      });
    }

    function setHover(node, relPath) {
      if (hoverNode && hoverNode !== node) hoverNode.classList.remove("is-over");
      hoverNode = node;
      node.classList.add("is-over");
      ui.status.dataset.kind = "idle";
      ui.status.textContent = `松开保存到 ${relPath ? relPath : "图库根目录"}`;
    }

    function clearHover() {
      if (hoverNode) hoverNode.classList.remove("is-over");
      hoverNode = null;
      if (ui) updateStatus();
    }

    /* ---- 状态与文案 ---- */

    function setStatus(kind, text) {
      statusKind = kind;
      statusText = text;
      updateStatus();
    }

    function updateStatus() {
      if (!ui) return;
      const text = lockedMessage ? lockedMessage : statusText;
      const kind = lockedMessage ? "blocked" : statusKind;
      ui.status.dataset.kind = kind;
      ui.status.textContent = text;
    }

    /* ---- 导航 ---- */

    function currentRelPath() {
      return joinRel(baseRel, stack);
    }

    function renderCrumb() {
      const segments = displayPath.split("/").filter((part) => part.length > 0);
      const cwd = currentRelPath();
      const cwdSegments = cwd.split("/").filter((part) => part.length > 0);
      ui.crumbLib.textContent = segments[0] ?? "参考图库";
      ui.crumbPath.textContent =
        segments.length > 1 ? segments.slice(1).join(" / ") : "（图库根目录）";
      ui.backButton.disabled = stack.length === 0;
      // 左栏投放区：当前目录名 + 相对路径
      ui.zoneName.textContent =
        cwdSegments[cwdSegments.length - 1] ?? segments[segments.length - 1] ?? "参考图库";
      ui.zonePath.textContent = cwd || "（图库根目录）";
    }

    function renderList(content) {
      ui.list.replaceChildren(content);
      // 每次重画都清掉上一次的「列表不完整」提示，避免换目录后残留
      ui.listNote.textContent = "";
    }

    function emptyRow(text) {
      return el("div", "empty", text);
    }

    async function loadView() {
      if (!ui) return;
      clearExpandArm();
      renderCrumb();
      setStatus("loading", "正在读取子目录…");
      renderList(emptyRow("加载中…"));
      try {
        const result = await handlers.loadChildren(currentRelPath());
        if (!opened) return;
        renderRows(result);
      } catch (error) {
        if (!opened) return;
        const text = errorText(error);
        renderList(emptyRow(`读取子目录失败：${text}`));
        setStatus("error", `读取子目录失败：${text}（不会退回到其他目录）`);
      }
    }

    function renderRows(result) {
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      if (entries.length === 0) {
        renderList(emptyRow("这个目录下没有子文件夹"));
        setStatus("idle", "没有子文件夹；松手保存到当前目录即可。");
      } else {
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
          fragment.append(buildRow(entry));
        }
        renderList(fragment);
        setStatus("idle", `共 ${entries.length} 个子文件夹；拖到某一行即保存到该目录。`);
      }
      if (result?.truncated) {
        const reason = result.truncatedReason === "timeout" ? "枚举超时" : "已达条数上限";
        ui.listNote.textContent = `列表不完整（${reason}）`;
      }
      applyLock();
      // 列表高度变了 → 重新夹进视口（卡片不能越出边界）
      placeCard();
    }

    function buildRow(entry) {
      const row = el("div", "row");
      row.dataset.relPath = entry.relPath;
      const name = el("div", "row-name", entry.name);
      name.title = entry.relPath;
      const expand = el("button", "row-expand is-hover-range", "展开下级");
      expand.type = "button";
      expand.title = `点一下，或拖图悬停 0.5 秒：进入 ${entry.name}`;
      expand.setAttribute("aria-label", `展开 ${entry.name} 的子文件夹`);
      row.append(name, expand);

      wireDirectoryDrop(row, () => entry.relPath);

      expand.addEventListener("click", () => enterDirectory(entry));
      expand.addEventListener("dragover", (event) => {
        if (lockedMessage) return;
        event.preventDefault();
        armExpand(entry, expand);
      });
      expand.addEventListener("dragleave", (event) => {
        if (leftElement(expand, event)) disarmExpand(entry.relPath);
      });
      row.addEventListener("dragleave", (event) => {
        if (leftElement(row, event)) disarmExpand(entry.relPath);
      });
      return row;
    }

    /** 拖图悬停 500ms → 读取该目录的直接子目录并进入 */
    function armExpand(entry, expandNode) {
      if (expandArmedRel === entry.relPath) return;
      disarmExpand(null);
      expandArmedRel = entry.relPath;
      expandNode.classList.add("is-armed");
      expandTimer = setTimeout(() => {
        expandTimer = null;
        expandArmedRel = null;
        expandNode.classList.remove("is-armed");
        enterDirectory(entry);
      }, HOVER_DWELL_MS);
    }

    function disarmExpand(relPath) {
      if (relPath !== null && expandArmedRel !== relPath) return;
      if (expandTimer !== null) {
        clearTimeout(expandTimer);
        expandTimer = null;
      }
      expandArmedRel = null;
      if (!ui) return;
      for (const node of ui.list.querySelectorAll(".row-expand.is-armed")) {
        node.classList.remove("is-armed");
      }
    }

    function clearBackTimer() {
      if (backTimer === null) return;
      clearTimeout(backTimer);
      backTimer = null;
    }

    function clearExpandArm() {
      disarmExpand(null);
      clearBackTimer();
    }

    /** 进入下一级：`entry.relPath` 已由图库列表给出，只把新增段压进栈 */
    function enterDirectory(entry) {
      clearHover();
      const prefix = currentRelPath();
      if (prefix && !entry.relPath.startsWith(`${prefix}/`)) return;
      const rest = entry.relPath.slice(prefix.length).replace(/^\/+/, "");
      if (!rest) return;
      stack = [...stack, ...rest.split("/")];
      void loadView();
    }

    function navigateUp() {
      clearBackTimer();
      if (stack.length === 0) return;
      stack = stack.slice(0, -1);
      void loadView();
    }

    /* ---- 锁定 ---- */

    function applyLock() {
      if (!ui) return;
      const locked = Boolean(lockedMessage);
      ui.currentZone.classList.toggle("is-locked", locked);
      for (const node of ui.list.querySelectorAll(".row")) {
        node.classList.toggle("is-locked", locked);
      }
      for (const node of ui.list.querySelectorAll(".row-expand")) {
        node.disabled = locked;
      }
    }

    function applyTheme(theme) {
      if (host) host.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
    }

    /** collect = 画范围标注（能真投）；notice = 只弹提示卡（连不上/已关闭/忙/被拦） */
    function applyMode(mode) {
      if (!host) return;
      const next = mode === "notice" ? "notice" : "collect";
      host.setAttribute("data-mode", next);
      if (ui) {
        ui.zoneLabel.textContent =
          next === "notice" ? "当前目录" : "松开保存到当前目录";
      }
    }

    function applyLockedMessage(message) {
      lockedMessage = message ?? null;
      // 锁定即撤掉范围标注（CSS 靠这个属性），避免"标着能投其实不能投"
      if (host) host.setAttribute("data-locked", lockedMessage ? "true" : "false");
      if (!ui) return;
      applyLock();
      updateStatus();
    }

    /* ---- 对外 API ---- */

    return {
      /**
       * 打开浮卡并定位到工具箱当前浏览目录。
       * @param {{
       *   displayPath: string,
       *   baseRelPath: string,
       *   theme?: "light" | "dark",
       *   mode?: "collect" | "notice",
       *   anchor?: {x: number, y: number} | null,
       * }} options
       *   mode 缺省 collect（画范围标注）；只有"提示但不可投"的场景才用 notice。
       *   anchor = 拖动起点（viewport 坐标），浮卡落在它旁边；缺省则居中兜底。
       */
      open(options) {
        if (!host) buildHost();
        baseRel = options.baseRelPath ?? "";
        displayPath = options.displayPath ?? "参考图库";
        anchor = normalizeAnchor(options.anchor);
        stack = [];
        lockedMessage = null;
        if (host) host.setAttribute("data-locked", "false");
        applyTheme(options.theme);
        applyMode(options.mode);
        if (!host.isConnected) {
          document.body.append(host);
          window.addEventListener("resize", handleViewportChange);
        }
        opened = true;
        renderCrumb();
        setStatus("idle", "正在连接工具箱…");
        applyLock();
        placeCard();
        void loadView();
      },

      close() {
        clearExpandArm();
        clearHover();
        opened = false;
        anchor = null;
        window.removeEventListener("resize", handleViewportChange);
        if (host && host.isConnected) host.remove();
        host = null;
        ui = null;
      },

      isOpen() {
        return opened;
      },

      currentRelPath,

      setTheme(theme) {
        applyTheme(theme);
      },

      /** 切换 collect / notice（范围标注随之显隐） */
      setMode(mode) {
        applyMode(mode);
      },

      /** 重设拖动起点（同一次会话里换拖动源时用；传 null 走居中兜底） */
      setAnchor(nextAnchor) {
        anchor = normalizeAnchor(nextAnchor);
        placeCard();
      },

      setStatus(kind, text) {
        if (!opened) return;
        setStatus(kind, text);
      },

      /** 禁投：传文案即锁定所有投放区（保存中 / 目标已变 / 未连接），传 null 解锁 */
      setLocked(message) {
        applyLockedMessage(message);
      },

      /** 目标版本变化：旧浮层作废，必须重新拖动 */
      invalidate() {
        applyLockedMessage("工具箱的浏览目标已变化，请重新拖动这张图片。");
      },

      /** 目录列表里是否含某个 relPath（无头断言用） */
      hasDirectory(relPath) {
        if (!ui) return false;
        for (const node of ui.list.querySelectorAll(".row")) {
          if (node.dataset.relPath === relPath) return true;
        }
        return false;
      },
    };
  }

  globalThis.YSTKOverlay = { create, toHostCss, COMPONENT_CSS };
})();
