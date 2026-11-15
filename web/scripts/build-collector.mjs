#!/usr/bin/env node
/**
 * [collector] 浏览器拖拽采集扩展的静态生成与自检（2026-11-12 任务卡 §4.5）。
 *
 * 做五件事，全部只用 Node 内置模块（不下载依赖、不联网）：
 *   1. 从 `src/styles/tokens.css` 生成扩展目录里的 `tokens.js`（唯一配色来源，禁止手抄副本）；
 *   1.5 把 `overlay.js` 的样式改写函数与 tokens 拼成真实样式表，做括号配对自检
 *       （括号不闭合会把整张表后面的规则吞掉，浮层变无样式纯文字，见 findUnbalancedBracket）；
 *   2. 校验 `manifest.json` 可解析、引用的文件都存在、没申请禁用权限/外部消息；
 *   3. 用 `node:vm` 编译扩展内每个经典脚本，语法错误直接让 build 失败；
 *   4. 核对扩展里的协议标识/版本与 `src/modules/library/collector/types.ts` 一致。
 *
 * 任何一项失败 → 退出码 1（`npm run build` 随之中断）。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_ROOT = join(WEB_ROOT, "extensions", "collector");
const TOKENS_CSS = join(WEB_ROOT, "src", "styles", "tokens.css");
const TOKENS_JS = join(EXT_ROOT, "tokens.js");
const OVERLAY_JS = join(EXT_ROOT, "overlay.js");
const MANIFEST = join(EXT_ROOT, "manifest.json");
const PROTOCOL_TS = join(WEB_ROOT, "src", "modules", "library", "collector", "types.ts");

const ALLOWED_PERMISSIONS = new Set(["storage", "tabs"]);
const ALLOWED_PERMISSION_PREFIXES = ["http://", "https://"];
const FORBIDDEN_MANIFEST_KEYS = ["externally_connectable", "content_security_policy", "update_url"];

function fail(message) {
  console.error(`[collector] 失败：${message}`);
  process.exit(1);
}

function rel(path) {
  return relative(WEB_ROOT, path).split("\\").join("/");
}

/* ---------------- 1. tokens.js ---------------- */

function buildTokens() {
  const css = readFileSync(TOKENS_CSS, "utf8");
  const source = [
    "// 由 web/scripts/build-collector.mjs 从 web/src/styles/tokens.css 生成，勿手改。",
    "// 扩展侧的 Shadow DOM 浮层与 popup 都用这份文本，禁止另抄一份硬编码配色。",
    "globalThis.YSTK_TOKENS = Object.freeze({",
    `  css: ${JSON.stringify(css)},`,
    "});",
    "",
  ].join("\n");
  writeFileSync(TOKENS_JS, source, "utf8");
  console.log(`[collector] tokens.js 已生成：${css.length} 字符 CSS`);
}

/* ---------------- 1.5 浮层样式自检（括号配对） ---------------- */

/**
 * 找第一处括号不配对的位置（跳过注释与字符串）；返回 null 表示没问题。
 *
 * 为什么必须有：浮层的样式是一整段字符串塞进 Shadow DOM 的，只要有一个 `(`
 * 没闭合，CSS 解析器会一路吞到文件尾，**后面所有规则被丢弃** —— 浮层退化成
 * 「无样式纯文字贴在网页上」，而 build / lint 都发现不了（2026-11-13 实踩：
 * `[data-theme="x"]` 改写成 `:host([data-theme="x"]` 少了闭合括号）。
 */
function findUnbalancedBracket(css) {
  const stack = [];
  const PAIRS = { ")": "(", "]": "[", "}": "{" };
  let line = 1;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "\n") {
      line += 1;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) return { line, message: "注释没有闭合" };
      line += css.slice(i, end).split("\n").length - 1;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) {
        if (css[j] === "\\") j += 1;
        else if (css[j] === "\n") line += 1;
        j += 1;
      }
      if (j >= css.length) return { line, message: "字符串没有闭合" };
      i = j;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      stack.push({ ch, line });
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const top = stack.pop();
      if (!top || top.ch !== PAIRS[ch]) return { line, message: `多余的 ${ch}` };
    }
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return { line: top.line, message: `${top.ch} 没有闭合` };
  }
  return null;
}

function checkOverlayStyle() {
  const tokensCss = readFileSync(TOKENS_CSS, "utf8");
  const context = vm.createContext({});
  try {
    // overlay.js 顶层只定义函数（不碰 document），可以安全求值后取它的改写函数
    vm.runInContext(readFileSync(OVERLAY_JS, "utf8"), context, { filename: rel(OVERLAY_JS) });
  } catch (error) {
    fail(`overlay.js 顶层求值失败：${error.message}`);
  }
  const api = context.YSTKOverlay;
  if (!api || typeof api.toHostCss !== "function" || typeof api.COMPONENT_CSS !== "string") {
    fail("overlay.js 必须导出 toHostCss 与 COMPONENT_CSS（样式自检要用）");
  }
  const probe = api.toHostCss(':root { --a: 1; }\n[data-theme="dark"] { --b: 2; }');
  if (!probe.includes(':host([data-theme="dark"])')) {
    fail('toHostCss 没把 [data-theme] 改写成带闭合括号的 :host([data-theme="…"])');
  }
  const css = `${api.toHostCss(tokensCss)}\n${api.COMPONENT_CSS}`;
  const problem = findUnbalancedBracket(css);
  if (problem) {
    fail(
      `Shadow DOM 样式括号不配对（第 ${problem.line} 行：${problem.message}）；` +
        "括号不闭合会把后面整张样式表吞掉，浮层会退化成无样式纯文字",
    );
  }
  console.log(`[collector] 浮层样式自检通过：${css.length} 字符，括号配对`);
}

/* ---------------- 2. manifest.json ---------------- */

function collectManifestFiles(manifest) {
  const files = [];
  const push = (file) => {
    if (typeof file === "string" && file) files.push(file);
  };

  push(manifest.background?.service_worker);
  push(manifest.action?.default_popup);
  for (const key of Object.keys(manifest.icons ?? {})) push(manifest.icons[key]);
  for (const entry of manifest.content_scripts ?? []) {
    for (const file of entry.js ?? []) push(file);
    for (const file of entry.css ?? []) push(file);
  }
  return [...new Set(files)];
}

function checkManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (error) {
    fail(`manifest.json 解析失败：${error.message}`);
  }

  if (manifest.manifest_version !== 3) fail("manifest_version 必须为 3（Manifest V3）");

  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (key in manifest) fail(`manifest.json 不得声明 ${key}`);
  }

  const permissions = manifest.permissions ?? [];
  for (const permission of permissions) {
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      fail(`permissions 只允许 storage / tabs，发现 ${permission}`);
    }
  }

  const hostPermissions = manifest.host_permissions ?? [];
  if (hostPermissions.length === 0) fail("host_permissions 不得为空（抓图与拖拽识别需要 HTTP(S) 站点）");
  for (const pattern of hostPermissions) {
    if (pattern === "<all_urls>") fail("host_permissions 不得使用 <all_urls>");
    if (!ALLOWED_PERMISSION_PREFIXES.some((prefix) => pattern.startsWith(prefix))) {
      fail(`host_permissions 只允许 http/https 匹配，发现 ${pattern}`);
    }
  }

  const scripts = manifest.content_scripts ?? [];
  if (scripts.length !== 2) fail(`content_scripts 应恰好两条（工具箱桥接 + 普通网页采集），实际 ${scripts.length}`);
  for (const entry of scripts) {
    for (const pattern of entry.matches ?? []) {
      if (pattern === "<all_urls>") fail("content_scripts.matches 不得使用 <all_urls>");
    }
  }

  const missing = collectManifestFiles(manifest).filter((file) => {
    try {
      return !statSync(join(EXT_ROOT, file)).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) fail(`manifest.json 引用的文件不存在：${missing.join("、")}`);

  const checked = collectManifestFiles(manifest).length;
  console.log(`[collector] manifest.json 通过：MV3、权限 ${permissions.join("/") || "无"}、引用 ${checked} 个文件`);
  return manifest;
}

/* ---------------- 3. 经典脚本语法 ---------------- */

function listJsFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      found.push(...listJsFiles(full));
      continue;
    }
    if (extname(name) === ".js") found.push(full);
  }
  return found.sort();
}

function checkScripts() {
  const files = listJsFiles(EXT_ROOT);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    try {
      new vm.Script(source, { filename: rel(file) });
    } catch (error) {
      fail(`${rel(file)} 语法错误：${error.message}`);
    }
  }
  console.log(`[collector] 扩展脚本语法通过：${files.length} 个文件`);
  return files;
}

/* ---------------- 4. 协议标识/版本一致 ---------------- */

function readProtocolFromTypes() {
  const source = readFileSync(PROTOCOL_TS, "utf8");
  const ns = source.match(/PROTOCOL_NS\s*=\s*"([^"]+)"/);
  const version = source.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  if (!ns || !version) fail("types.ts 里找不到 PROTOCOL_NS / PROTOCOL_VERSION 常量");
  return { ns: ns[1], version: Number(version[1]) };
}

function readProtocolFromScript(source, file) {
  const ns = source.match(/PROTOCOL_NS\s*=\s*"([^"]+)"/);
  const version = source.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  if (!ns || !version) fail(`${rel(file)} 缺少 PROTOCOL_NS / PROTOCOL_VERSION 常量`);
  return { ns: ns[1], version: Number(version[1]) };
}

/** 约定：凡声明了 PROTOCOL_NS 的扩展脚本都参与核对；后台与工具箱桥接必须声明 */
const PROTOCOL_MUST_DECLARE = ["background.js", "toolkit-bridge.js"];

function checkProtocol(files) {
  const truth = readProtocolFromTypes();
  const declared = new Set();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("PROTOCOL_NS")) continue;
    const got = readProtocolFromScript(source, file);
    if (got.ns !== truth.ns || got.version !== truth.version) {
      fail(
        `${rel(file)} 协议为 ${got.ns}/v${got.version}，与 types.ts 的 ${truth.ns}/v${truth.version} 不一致`,
      );
    }
    declared.add(rel(file).split("/").pop() ?? "");
  }
  for (const name of PROTOCOL_MUST_DECLARE) {
    if (!declared.has(name)) fail(`${name} 必须声明 PROTOCOL_NS / PROTOCOL_VERSION 以便核对协议`);
  }
  console.log(`[collector] 协议一致：${truth.ns} v${truth.version}（${declared.size} 个脚本声明）`);
}

buildTokens();
checkOverlayStyle();
checkManifest();
const scripts = checkScripts();
checkProtocol(scripts);
console.log("[collector] 全部通过");
