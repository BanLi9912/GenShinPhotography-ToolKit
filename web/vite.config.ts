import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { Plugin, ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = dirname(fileURLToPath(import.meta.url));
const ortJsDir = resolve(webRoot, "public/superres-assets/js");

/**
 * onnxruntime-web 会在运行时动态 import ORT 的 Emscripten 胶水 .mjs；
 * Vite dev 会把这类请求交给 transform 中间件，而 /public 文件不允许被 import。
 * 这里在 dev 下直接返回原文件内容（生产环境由静态服务器原样提供，无需此中间件）。
 */
function serveSuperResOrtJs(): Plugin {
  return {
    name: "serve-superres-ort-js",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        const match =
          /^\/superres-assets\/js\/(ort-wasm-simd-threaded(?:\.jsep)?\.mjs)$/.exec(
            pathname,
          );
        if (!match) return next();
        try {
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.end(readFileSync(resolve(ortJsDir, match[1])));
        } catch {
          next();
        }
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * 「在文件夹中打开」（dev 中间件）
 *
 * 为什么放在 dev server：浏览器（FSA showDirectoryPicker）拿不到图库的
 * 绝对路径——FileSystemDirectoryHandle 按设计不暴露 path，注册表里只存
 * 目录名（index/binding.ts 的 pathHint）。只有 Node 进程能落盘找路径，
 * 所以前端报「图库 id + 库内相对路径」，这里反查绝对路径后调
 * explorer /select 弹出资源管理器并单击选中该图片。
 *
 * 仅 dev 生效：生产构建是静态站点，没有 Node 进程可依托（要走桌面壳/
 * 本地服务才能覆盖生产，见开发文档 §3.2 的双进程结构）。
 * ------------------------------------------------------------------ */

/**
 * 反查搜索根：用户图库通常不在仓库内（可能在别的盘），所以默认覆盖
 * 仓库上级 + 用户主目录 + 各盘根，命中后进缓存不再扫盘。
 * `YSTK_REVEAL_ROOT` 可显式覆盖（多个用 `;` 分隔，如 `D:\照片;E:\参考`）。
 */
function defaultRevealRoots(): string[] {
  const roots = [resolve(webRoot, "..")];
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) roots.push(resolve(home));
  if (process.platform === "win32") {
    // A–Z 中真实存在的盘根（盘不存在时 existsSync 直接 false）
    for (let code = 65; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (existsSync(drive)) roots.push(drive);
    }
  }
  return roots;
}

const REVEAL_ROOTS = (() => {
  const raw = process.env.YSTK_REVEAL_ROOT;
  const list = raw
    ? raw
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => resolve(p))
    : defaultRevealRoots();
  return [...new Set(list)];
})();

/**
 * 搜索深度上限与跳过目录（避免在 node_modules/.git/AppData 里白扫）。
 * 盘根起搜时深度 6 只覆盖浅层目录（`D:\照片\2024\外拍\精选` 这类）；
 * 更深或命中失败时用 YSTK_REVEAL_ROOT 指到具体父目录，命中后进缓存。
 */
const REVEAL_MAX_DEPTH = 6;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".tools",
  "AppData",
  "$RECYCLE.BIN",
  "System Volume Information",
]);

/**
 * 单次扫盘时间预算（默认 20s，`YSTK_REVEAL_BUDGET_MS` 可调）。
 * 冷启动扫全盘实测可达 60s+（C:\ 深度 6 就有 7.4 万目录），超预算即中止
 * 并提示用 YSTK_REVEAL_ROOT 收窄范围——不能让用户干等，也不能让 Node
 * 一直扫盘。命中过的库进缓存，后续请求不再扫盘。
 */
const REVEAL_BUDGET_MS = Number(process.env.YSTK_REVEAL_BUDGET_MS ?? 20000);

type RevealRootHit =
  | { status: "found"; root: string }
  | { status: "missing" }
  | { status: "timeout" };

interface RevealRootCacheEntry {
  /** null = 该库未找到（含超时）；避免每次点击都重扫全盘 */
  root: string | null;
  at: number;
  /** 未命中是否因预算耗尽（缓存期内复现同一原因） */
  timedOut: boolean;
}

/** libraryId → 图库根目录（命中常驻；未命中也缓存，TTL 内不重扫） */
const revealRootCache = new Map<string, RevealRootCacheEntry>();
/** 未命中缓存的有效期：图库被移动/重绑定后不至于永久失效 */
const REVEAL_MISS_TTL_MS = 60_000;

/* ------------------------------------------------------------------ *
 * 图库磁盘位置登记表（`web/.ystk-library-paths.json`，已进 .gitignore）
 *
 * 浏览器句柄只给能力不给路径，所以「在文件夹中打开」需要一份
 * libraryId → 绝对路径 的映射。来源两条：
 *   - config：用户在设置中心「图库注册表」里手动登记/选择目录
 *   - scan：扫盘命中后自动记住
 * 有 config 记录时直接命中，不再扫盘（0 秒）。
 * ------------------------------------------------------------------ */

const LIBRARY_PATHS_FILE = resolve(webRoot, ".ystk-library-paths.json");

interface LibraryPathEntry {
  libraryId: string;
  /** 绝对路径（图库根目录） */
  path: string;
  /** config = 用户登记；scan = 扫盘命中自动记住 */
  source: "config" | "scan";
  addedAt: number;
}

interface LibraryPathsStore {
  version: 1;
  entries: LibraryPathEntry[];
}

/** 读登记表（文件不存在/写坏按空处理；带 BOM 容忍） */
async function readLibraryPaths(): Promise<LibraryPathsStore> {
  try {
    const raw = (await readFile(LIBRARY_PATHS_FILE, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<LibraryPathsStore>;
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries.filter(
          (e): e is LibraryPathEntry =>
            !!e &&
            typeof e.libraryId === "string" &&
            typeof e.path === "string" &&
            (e.source === "config" || e.source === "scan"),
        )
      : [];
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

/** 写登记表（tmp + rename 原子写，避免半截 JSON） */
async function writeLibraryPaths(store: LibraryPathsStore): Promise<void> {
  const tmp = `${LIBRARY_PATHS_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, LIBRARY_PATHS_FILE);
}

/** 新增/覆盖一条登记（config 覆盖 scan；scan 不覆盖已有 config） */
async function upsertLibraryPath(entry: LibraryPathEntry): Promise<void> {
  const store = await readLibraryPaths();
  const idx = store.entries.findIndex((e) => e.libraryId === entry.libraryId);
  if (idx >= 0) {
    const prev = store.entries[idx];
    if (prev.source === "config" && entry.source === "scan") return;
    store.entries[idx] = entry;
  } else {
    store.entries.push(entry);
  }
  await writeLibraryPaths(store);
}

/** 删除一条登记（返回是否删到） */
async function removeLibraryPath(libraryId: string): Promise<boolean> {
  const store = await readLibraryPaths();
  const next = store.entries.filter((e) => e.libraryId !== libraryId);
  if (next.length === store.entries.length) return false;
  await writeLibraryPaths({ version: 1, entries: next });
  return true;
}

/** 读登记表里的绝对路径（登记存在但目录已不在 → 视为未登记） */
async function lookupConfiguredPath(libraryId: string): Promise<string | null> {
  const store = await readLibraryPaths();
  const hit = store.entries.find((e) => e.libraryId === libraryId);
  if (!hit) return null;
  return existsSync(join(hit.path, ".ystk", "meta.json")) ? hit.path : null;
}

interface RevealBody {
  libraryId?: unknown;
  relPath?: unknown;
  libraryName?: unknown;
  /** 登记表 POST 用：图库绝对路径 */
  path?: unknown;
  /** 只解析不弹窗（自验用：返回解析到的绝对路径） */
  dryRun?: unknown;
  /** 「模块组件」安装动作的目标（白名单校验） */
  target?: unknown;
}

/** 递归找 `.ystk/meta.json` 中 libraryId 匹配的图库根（异步 + 预算，见 REVEAL_BUDGET_MS） */
async function findLibraryRoot(
  dir: string,
  libraryId: string,
  depth: number,
  deadline: number,
): Promise<RevealRootHit> {
  if (depth > REVEAL_MAX_DEPTH) return { status: "missing" };
  if (Date.now() > deadline) return { status: "timeout" };
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { status: "missing" };
  }
  if (entries.includes(".ystk")) {
    try {
      // 容忍 UTF-8 BOM（部分编辑器/脚本写出的 meta.json 带 BOM，JSON.parse 会直接抛）
      const raw = (await readFile(join(dir, ".ystk", "meta.json"), "utf8")).replace(
        /^\uFEFF/,
        "",
      );
      const meta = JSON.parse(raw) as { libraryId?: unknown };
      if (meta?.libraryId === libraryId) return { status: "found", root: dir };
    } catch {
      /* meta.json 缺失/半截：继续向下找 */
    }
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const child = join(dir, name);
    try {
      if (!(await stat(child)).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = await findLibraryRoot(child, libraryId, depth + 1, deadline);
    if (hit.status !== "missing") return hit;
  }
  return { status: "missing" };
}

/**
 * 解析图库根：**先查登记表（0 秒）**，未登记才扫盘；
 * 扫盘命中顺手写回登记表（source: scan），下次直接命中。
 */
async function resolveLibraryRoot(libraryId: string): Promise<RevealRootHit> {
  const configured = await lookupConfiguredPath(libraryId);
  if (configured) return { status: "found", root: configured };

  const cached = revealRootCache.get(libraryId);
  if (cached) {
    if (cached.root && existsSync(join(cached.root, ".ystk", "meta.json"))) {
      return { status: "found", root: cached.root };
    }
    if (!cached.root && Date.now() - cached.at < REVEAL_MISS_TTL_MS) {
      return cached.timedOut ? { status: "timeout" } : { status: "missing" };
    }
    revealRootCache.delete(libraryId);
  }
  const deadline = Date.now() + REVEAL_BUDGET_MS;
  let timedOut = false;
  for (const root of REVEAL_ROOTS) {
    const hit = await findLibraryRoot(root, libraryId, 0, deadline);
    if (hit.status === "found") {
      revealRootCache.set(libraryId, {
        root: hit.root,
        at: Date.now(),
        timedOut: false,
      });
      // 扫到的结果落进登记表：dev server 重启后不必再扫
      await upsertLibraryPath({
        libraryId,
        path: hit.root,
        source: "scan",
        addedAt: Date.now(),
      }).catch(() => undefined);
      return hit;
    }
    if (hit.status === "timeout") {
      timedOut = true;
      break;
    }
  }
  revealRootCache.set(libraryId, { root: null, at: Date.now(), timedOut });
  return timedOut ? { status: "timeout" } : { status: "missing" };
}

/** 库内相对路径 → 绝对路径（`/` 分段，拒绝越界段） */
function joinRelPath(root: string, relPath: string): string | null {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "." || p === ".." || p.includes("\\"))) return null;
  return join(root, ...parts);
}

/** 弹资源管理器并选中文件（Windows / macOS / Linux 各一档） */
function revealInFileManager(filePath: string): Promise<void> {
  return new Promise((promiseResolve, promiseReject) => {
    if (process.platform === "win32") {
      // explorer 成功选中时退出码常为 1（不是失败信号），只看能否拉起进程
      execFile("explorer.exe", [`/select,${filePath}`], (err) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          promiseReject(err);
          return;
        }
        promiseResolve();
      });
      return;
    }
    if (process.platform === "darwin") {
      execFile("open", ["-R", filePath], (err) =>
        err ? promiseReject(err) : promiseResolve(),
      );
      return;
    }
    execFile(
      "dbus-send",
      [
        "--session",
        "--dest=org.freedesktop.FileManager1",
        "--type=method_call",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        `array:string:${filePath}`,
        "string:",
      ],
      (err) => (err ? promiseReject(err) : promiseResolve()),
    );
  });
}

function sendJson(
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b: string) => void },
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readJsonBody(req: { on: (e: string, cb: (chunk?: unknown) => void) => void }): Promise<RevealBody> {
  return new Promise((promiseResolve, promiseReject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk ?? "");
      if (raw.length > 4096) promiseReject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        promiseResolve(raw ? (JSON.parse(raw) as RevealBody) : {});
      } catch {
        promiseReject(new Error("invalid json"));
      }
    });
    req.on("error", () => promiseReject(new Error("read error")));
  });
}

/** 「在文件夹中打开」中间件：POST /__ystk/reveal { libraryId, relPath, libraryName?, dryRun? } */
function serveRevealInFolder(): Plugin {
  return {
    name: "serve-ystk-reveal-in-folder",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (pathname !== "/__ystk/reveal") return next();
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "仅支持 POST" });
          return;
        }
        void (async () => {
          let body: RevealBody;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
            return;
          }
          const libraryId = typeof body.libraryId === "string" ? body.libraryId : "";
          const relPath = typeof body.relPath === "string" ? body.relPath : "";
          const libraryName =
            typeof body.libraryName === "string" ? body.libraryName : "";
          if (!libraryId || !relPath) {
            sendJson(res, 400, { ok: false, error: "缺少 libraryId 或 relPath" });
            return;
          }
          const hit = await resolveLibraryRoot(libraryId);
          if (hit.status !== "found") {
            const scanned = REVEAL_ROOTS.slice(0, 6).join(" / ");
            const more = REVEAL_ROOTS.length > 6 ? ` 等 ${REVEAL_ROOTS.length} 处` : "";
            const reason =
              hit.status === "timeout"
                ? `扫盘超过 ${Math.round(REVEAL_BUDGET_MS / 1000)} 秒预算已中止`
                : `已搜 ${scanned}${more}`;
            sendJson(res, 404, {
              ok: false,
              error: `找不到图库「${
                libraryName || libraryId
              }」所在的磁盘目录（${reason}）。设环境变量 YSTK_REVEAL_ROOT 指向它所在目录（多个用 ; 分隔）后重启 dev server 即可`,
            });
            return;
          }
          const abs = joinRelPath(hit.root, relPath);
          if (!abs) {
            sendJson(res, 400, { ok: false, error: "相对路径非法" });
            return;
          }
          if (!existsSync(abs)) {
            sendJson(res, 404, {
              ok: false,
              error: `文件不在磁盘上：${abs}（可能已移动/重命名，可重扫图库）`,
            });
            return;
          }
          if (body.dryRun === true) {
            sendJson(res, 200, { ok: true, path: abs, revealed: false });
            return;
          }
          try {
            await revealInFileManager(abs);
          } catch (err) {
            sendJson(res, 500, {
              ok: false,
              error: `调起文件管理器失败：${(err as Error).message}`,
            });
            return;
          }
          sendJson(res, 200, { ok: true, path: abs, revealed: true });
        })();
      });
    },
  };
}

/**
 * 图库路径登记表中间件（设置中心「图库注册表」用）：
 *   GET    /__ystk/library-paths          → { ok, entries: [{libraryId, path, source, exists}] }
 *   POST   /__ystk/library-paths          → { path, libraryId? } 登记（libraryId 缺省时取目录里的 meta.json；
 *                                           传入时校验是否与目录一致）
 *   DELETE /__ystk/library-paths?libraryId=… → 删除一条
 */
function serveLibraryPaths(): Plugin {
  return {
    name: "serve-ystk-library-paths",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const [pathname, search] = (req.url ?? "").split("?");
        if (pathname !== "/__ystk/library-paths") return next();

        if (req.method === "GET") {
          void (async () => {
            const store = await readLibraryPaths();
            sendJson(res, 200, {
              ok: true,
              entries: store.entries.map((e) => ({
                ...e,
                exists: existsSync(join(e.path, ".ystk", "meta.json")),
              })),
            });
          })();
          return;
        }

        if (req.method === "DELETE") {
          void (async () => {
            const libraryId = new URLSearchParams(search ?? "").get("libraryId") ?? "";
            if (!libraryId) {
              sendJson(res, 400, { ok: false, error: "缺少 libraryId" });
              return;
            }
            const removed = await removeLibraryPath(libraryId);
            revealRootCache.delete(libraryId);
            sendJson(res, 200, { ok: true, removed });
          })();
          return;
        }

        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "仅支持 GET / POST / DELETE" });
          return;
        }
        void (async () => {
          let body: RevealBody;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
            return;
          }
          const rawPath = typeof body.path === "string" ? body.path.trim() : "";
          const wantId = typeof body.libraryId === "string" ? body.libraryId.trim() : "";
          if (!rawPath) {
            sendJson(res, 400, { ok: false, error: "缺少 path" });
            return;
          }
          const abs = resolve(rawPath.replace(/^"|"$/g, ""));
          if (!existsSync(abs)) {
            sendJson(res, 404, { ok: false, error: `目录不存在：${abs}` });
            return;
          }
          const metaFile = join(abs, ".ystk", "meta.json");
          if (!existsSync(metaFile)) {
            sendJson(res, 404, {
              ok: false,
              error: `该目录不是图库（缺 .ystk/meta.json）：${abs}`,
            });
            return;
          }
          let metaId = "";
          try {
            const raw = (await readFile(metaFile, "utf8")).replace(/^\uFEFF/, "");
            metaId = String((JSON.parse(raw) as { libraryId?: unknown })?.libraryId ?? "");
          } catch {
            sendJson(res, 400, { ok: false, error: `meta.json 读取失败：${metaFile}` });
            return;
          }
          if (!metaId) {
            sendJson(res, 400, { ok: false, error: `meta.json 里没有 libraryId：${metaFile}` });
            return;
          }
          if (wantId && wantId !== metaId) {
            sendJson(res, 400, {
              ok: false,
              error: `目录与图库对不上：该目录的 libraryId 是 ${metaId}，不是 ${wantId}`,
            });
            return;
          }
          await upsertLibraryPath({
            libraryId: metaId,
            path: abs,
            source: "config",
            addedAt: Date.now(),
          });
          revealRootCache.delete(metaId);
          sendJson(res, 200, {
            ok: true,
            entry: { libraryId: metaId, path: abs, source: "config" },
          });
        })();
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * 「模块组件」状态与安装（dev 中间件）
 *
 * 设置中心 → 通用 → 模块组件：只读查询「必需组件 + 两条可选安装线」的就绪状态，
 * 并提供两条可选线的**真实安装动作**。
 *
 * 许可边界（PR-011，硬约束）：本中间件**不内置、不转存、不自托管任何权重字节**，
 * 只携带权利人官方渠道 URL（HuggingFace / ModelScope / GitHub Release）——
 * 每个最终用户从权利人处下载、本地转换、本地使用。Kim2091 系为 CC BY-NC-SA 4.0
 * （非商用）；Real-CUGAN 上游无 LICENSE 文件，ModelScope 官方仓库另有 LICENSE，
 * 以其为准。
 *
 * 仅 dev 生效（configureServer）：`vite preview` / 生产静态站点没有 Node 进程，
 * 面板会降级为「仅浏览器侧检查」。
 * ------------------------------------------------------------------ */

/** Kim2091 的 AnimeSharpV4 官方 ONNX（fp16/op17）；镜像主 → 官方回退 */
const HF_MIRROR = "https://hf-mirror.com";
const HF_OFFICIAL = "https://huggingface.co";
const TEXTURE_FAST_FILE = "2x-AnimeSharpV4_RCAN_fp16_op17.onnx";
const TEXTURE_FAST_URL_PATH = `Kim2091/2x-AnimeSharpV4/resolve/main/${TEXTURE_FAST_FILE}`;
const TEXTURE_FAST_MIN_BYTES = 30_000_000;

/**
 * Phase 0 实测结论（2026-09-16）：
 *  - AnimeSharpV4 官方 ONNX（fp16/op17）双后端都能**加载**，但输入张量声明 fp16、
 *    拒绝引擎现有的 float32 输入（`Unexpected input data type ... expected float16`）；
 *    改喂 fp16 后 WASM 能跑通（与自转 fp32 版 max|Δ|=0.0309，×255 约 7.9 级），
 *    但 **WebGPU 后端崩**（`[Conv] kernel failed`）——快路径要能用得先给 worker 加输入
 *    dtype 适配层并解决 WebGPU 崩溃，都不在本卡范围内；
 *  - 1x-SuperScale 作者未在 HF 分发 ONNX（其名下 7 个 HF 仓库已逐个核对）。
 *  → 纹理线整体走 install.bat 的 `/texture` 流程（两个模型都由官方 safetensors 本地转换，
 *    与 CUGAN 线共用 Python 工具链），即 `textureFastPath = false`。
 */
const TEXTURE_FAST_PATH = false;

/** 超分「专业档」期望产物（与 superres/engine.ts 的 MODEL_FILES/SUPERSCALE_DEF/ANIMESHARP_DEF 一致） */
const PRO_TEXTURE_FILES = ["superscale-1x.onnx", "animesharpv4-2x.onnx"];
const PRO_CUGAN_FILES = [
  "up3x-latest-no-denoise.onnx",
  "up3x-latest-denoise3x.onnx",
  "up3x-latest-conservative.onnx",
  "up4x-latest-no-denoise.onnx",
  "up4x-latest-denoise3x.onnx",
  "up4x-latest-conservative.onnx",
];

/** 必需：upscalejs 提供的 2x 五档（copy-superres-assets.mjs:28-34） */
const ASSET_2X_MODELS = [
  "up2x-latest-no-denoise.onnx",
  "up2x-latest-denoise1x.onnx",
  "up2x-latest-denoise2x.onnx",
  "up2x-latest-denoise3x.onnx",
  "up2x-latest-conservative.onnx",
];
/** 必需：ORT 运行时（copy-superres-assets.mjs:19-25） */
const ASSET_ORT_JS = [
  "ort.min.mjs",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
];

/** npm 依赖就绪判据（与 install.bat 一致），外加 vite 自身 */
const REQUIRED_DEPS = ["vite", "onnxruntime-web", "upscalejs"];

/** 便携 Node 版本合格线：^20.19.0 || >=22.12.0（与 install.bat / start-web.bat 口径一致） */
function nodeVersionOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\./.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === 20) return minor >= 19;
  if (major === 21) return false;
  if (major === 22) return minor >= 12;
  return major > 22;
}

interface ComponentStatus {
  ok: boolean;
  missing: string[];
}

interface ComponentsReport {
  node: { ok: boolean; version: string; path: string; required: string };
  deps: ComponentStatus;
  superres2x: ComponentStatus;
  superresPro: { ok: false | true; installed: string[]; missing: string[] };
  textureFastPath: boolean;
  textureMissing: string[];
  cuganMissing: string[];
  assetsDir: string;
  srModelsDir: string;
  installable: {
    deps: boolean;
    node: boolean;
    superres2x: boolean;
    texture: boolean;
    cugan: boolean;
  };
}

/** 状态计算带 1.5s 微缓存：面板「重新检测」连点不重复打满磁盘 */
const componentsCache: { at: number; report: ComponentsReport } = { at: 0, report: null as never };
const COMPONENTS_CACHE_MS = 1500;

function fileReady(path: string, minBytes = 1): boolean {
  try {
    const st = statSync(path);
    return st.isFile() && st.size >= minBytes;
  } catch {
    return false;
  }
}

function missingIn(dir: string, files: string[]): string[] {
  return files.filter((f) => !fileReady(join(dir, f)));
}

function computeComponents(): ComponentsReport {
  if (componentsCache.report && Date.now() - componentsCache.at < COMPONENTS_CACHE_MS) {
    return componentsCache.report;
  }
  const srModelsDir = resolve(webRoot, "sr-models");
  const assetsDir = resolve(webRoot, "public/superres-assets");
  const nodeVersion = process.version;
  const depsMissing = REQUIRED_DEPS.filter(
    (p) => !existsSync(resolve(webRoot, "node_modules", p, "package.json")),
  );
  const asset2xMissing = [
    ...missingIn(resolve(assetsDir, "models"), ASSET_2X_MODELS),
    ...missingIn(resolve(assetsDir, "js"), ASSET_ORT_JS),
  ];
  const proExpected = [...PRO_TEXTURE_FILES, ...PRO_CUGAN_FILES];
  const proInstalled = proExpected.filter((f) => fileReady(join(srModelsDir, f)));
  const proMissing = proExpected.filter((f) => !proInstalled.includes(f));
  const report: ComponentsReport = {
    node: {
      ok: nodeVersionOk(nodeVersion),
      version: nodeVersion,
      path: process.execPath,
      required: "^20.19.0 || >=22.12.0",
    },
    deps: { ok: depsMissing.length === 0, missing: depsMissing },
    superres2x: { ok: asset2xMissing.length === 0, missing: asset2xMissing },
    superresPro: { ok: proMissing.length === 0, installed: proInstalled, missing: proMissing },
    textureFastPath: TEXTURE_FAST_PATH,
    textureMissing: PRO_TEXTURE_FILES.filter((f) => !fileReady(join(srModelsDir, f))),
    cuganMissing: PRO_CUGAN_FILES.filter((f) => !fileReady(join(srModelsDir, f))),
    assetsDir,
    srModelsDir,
    // 必需组件不提供安装动作（那是 scripts/install.bat 的职责），只有两条可选线是真按钮
    installable: {
      deps: false,
      node: false,
      superres2x: false,
      texture: true,
      cugan: true,
    },
  };
  componentsCache.report = report;
  componentsCache.at = Date.now();
  return report;
}

/** 带超时与体积校验的下载（先镜像后官方由调用方决定顺序） */
async function downloadTo(url: string, dest: string, minBytes: number): Promise<void> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(240_000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < minBytes) {
    throw new Error(`下载体积异常（${buf.byteLength} 字节 < ${minBytes}）：${url}`);
  }
  await writeFile(dest, buf);
}

/** 跑 npm run predev（复制 sr-models → public/superres-assets） */
function runPredev(): Promise<string> {
  return new Promise((promiseResolve, promiseReject) => {
    // 直接用便携 Node 跑 npm-cli.js：不经 shell，路径含空格也安全
    const nodeDir = resolve(webRoot, "..", ".tools", "node");
    const node = existsSync(join(nodeDir, "node.exe")) ? join(nodeDir, "node.exe") : process.execPath;
    const npmCli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    const args = existsSync(npmCli)
      ? [npmCli, "run", "predev"]
      : ["run", "predev"];
    execFile(
      node,
      args,
      { cwd: webRoot, timeout: 120_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          promiseReject(new Error(`predev 失败：${String(stderr || err.message).slice(-400)}`));
          return;
        }
        promiseResolve(String(stdout).trim().split(/\r?\n/).slice(-3).join(" | "));
      },
    );
  });
}

/** 同 target 并发防护（中间件内存标记即可） */
const runningInstalls = new Set<string>();

/** 纹理线快路径：HF 官方 ONNX → web/sr-models → predev */
async function installTextureFastPath(): Promise<{ file: string; bytes: number }> {
  const dest = resolve(webRoot, "sr-models", "animesharpv4-2x.onnx");
  let lastError = "";
  for (const base of [HF_MIRROR, HF_OFFICIAL]) {
    try {
      await downloadTo(`${base}/${TEXTURE_FAST_URL_PATH}`, dest, TEXTURE_FAST_MIN_BYTES);
      lastError = "";
      break;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  if (lastError) throw new Error(lastError);
  await runPredev();
  return { file: TEXTURE_FAST_FILE, bytes: statSync(dest).size };
}

/**
 * CUGAN / 纹理线：**后台** spawn scripts/install.bat（参数模式）
 *
 * `windowsHide: true` = 不弹任何窗口（A 审查 2026-09-17 裁定：面板侧统一为"后台运行 +
 * 日志文件"口径，故三处文案都不得再出现"会打开安装窗口"）。进度可见性由两处承担：
 *   ① stdout/stderr 全量落 `scripts/install-<target>.log`（面板 toast 带出该路径）；
 *   ② 面板「重新检测」读 `GET /api/components` 看产物是否就位。
 * 接口立即返回 `{ok, started:true, mode:"script", log}`，不做进度流。
 *
 * `chcp 936 &&` 前缀是必需的：install.bat 是 GBK 文件，而 spawn 出来的新控制台默认
 * 代码页是 UTF-8（本机实测），cmd 会按错误代码页解析整个批处理文件，中文行变成乱码后
 * 被当命令执行（'xxx' 不是内部或外部命令）。先把代码页切到 936 再交给 cmd 解析文件。
 */
function spawnInstallScript(target: "texture" | "cugan"): { log: string } {
  const script = resolve(webRoot, "..", "scripts", "install.bat");
  if (!existsSync(script)) throw new Error(`找不到安装脚本：${script}`);
  const logFile = resolve(webRoot, "..", "scripts", `install-${target}.log`);
  const fd = openSync(logFile, "w");
  try {
    const child = spawn("cmd.exe", ["/c", `chcp 936 >nul && "${script}" /${target}`], {
      cwd: resolve(webRoot, ".."),
      detached: true,
      windowsHide: true,
      // 必须 verbatim：Node 默认会给参数里的引号加反斜杠转义，而 cmd.exe 不认 \"，
      // 结果把 `"D:\...\install.bat"` 当成命令名报「不是内部或外部命令」（实测踩过）。
      windowsVerbatimArguments: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  return { log: logFile };
}

function serveSystemComponents(): Plugin {
  return {
    name: "serve-ystk-system-components",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];

        // 轻量健康探测（顶栏「本地服务」指示灯用，2026-10-02）：只证明**本地
        // dev server / Node 中间件在跑**，不读盘、不缓存、不算组件状态——所以
        // 独立于 /api/components（那个要读盘、量体积、带 1.5s 微缓存，当心跳太重）。
        // 语义：200 = 本地服务在线（「在文件夹中打开」「图库注册表」「识图代理」
        // 「组件安装」可用）；404 = 纯静态构建（无 Node 侧能力）；连不上 = 没跑。
        if (pathname === "/api/health") {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "仅支持 GET" });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            app: "yuanshe-toolkit",
            node: process.version,
            platform: process.platform,
            pid: process.pid,
            at: Date.now(),
          });
          return;
        }

        if (pathname !== "/api/components" && pathname !== "/api/components/install") {
          return next();
        }

        if (pathname === "/api/components") {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "仅支持 GET" });
            return;
          }
          sendJson(res, 200, computeComponents());
          return;
        }

        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "仅支持 POST" });
          return;
        }
        void (async () => {
          let body: RevealBody;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
            return;
          }
          const target = typeof body.target === "string" ? body.target : "";
          // target 白名单：拒绝其余一切值，绝不透传命令
          if (target !== "texture" && target !== "cugan") {
            sendJson(res, 400, {
              ok: false,
              error: `target 非法：${target || "(空)"}（只接受 texture / cugan）`,
            });
            return;
          }
          if (runningInstalls.has(target)) {
            sendJson(res, 409, { ok: false, reason: "已有安装任务进行中" });
            return;
          }

          if (target === "texture" && !TEXTURE_FAST_PATH) {
            runningInstalls.add(target);
            try {
              const { log } = spawnInstallScript("texture");
              // 脚本自己会在公共控制台窗口里跑到底，面板用「重新检测」看结果；
              // 中间件这侧不长期占用标记（否则用户重试会被 409 挡死）。
              runningInstalls.delete(target);
              sendJson(res, 200, {
                ok: true,
                started: true,
                mode: "script",
                log,
                message:
                  "安装已在后台启动（scripts\\install.bat /texture），日志：scripts\\install-texture.log；完成后回到本面板点「重新检测」查看结果。",
              });
            } catch (err) {
              runningInstalls.delete(target);
              sendJson(res, 500, { ok: false, error: (err as Error).message });
            }
            return;
          }

          if (target === "texture") {
            runningInstalls.add(target);
            try {
              const info = await installTextureFastPath();
              componentsCache.at = 0;
              sendJson(res, 200, { ok: true, mode: "fast", ...info });
            } catch (err) {
              sendJson(res, 500, { ok: false, reason: (err as Error).message });
            } finally {
              runningInstalls.delete(target);
            }
            return;
          }

          runningInstalls.add(target);
          try {
            const { log } = spawnInstallScript("cugan");
            runningInstalls.delete(target);
            sendJson(res, 200, {
              ok: true,
              started: true,
              mode: "script",
              log,
              message: "CUGAN 3x/4x 安装已在后台启动，日志：scripts\\install-cugan.log；完成后回到本面板点「重新检测」查看结果。",
            });
          } catch (err) {
            runningInstalls.delete(target);
            sendJson(res, 500, { ok: false, error: (err as Error).message });
          }
        })();
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * 开发者日志落盘（dev 中间件，2026-09-24 任务卡 v2）
 *
 * 浏览器侧 core/diagnostics/logger 周期把**新增**日志行 POST 过来，这里
 * 追加写到仓库根 devdata/logs/<会话>.jsonl。目录结构在首次写入时一次建好：
 * devdata/logs/ + devdata/backup/（backup 为后续备份功能预留——用户口径：
 * 建 devdata 时直接建好 backup，不留到将来补）。保留最近 30 个会话文件。
 *
 * 仅 dev 生效：vite preview / 生产静态站没有本中间件，浏览器侧自动降级
 * 为仅内存记录（设置行有提示），主程序不受影响。
 * ------------------------------------------------------------------ */

/** devdata 根（仓库根下，与 .tools/ 同级） */
const DEVLOG_DIR = resolve(webRoot, "..", "devdata");
/** 会话文件保留数 */
const DEVLOG_KEEP = 30;
/** 单次上报 body 上限（B）：既有 readJsonBody 的 4KB 上限不适用日志批量 */
const DEVLOG_BODY_LIMIT = 2 * 1024 * 1024;

interface DevLogBody {
  file?: unknown;
  text?: unknown;
}

/** 读 devlog 请求体（大上限版；结构对齐 readJsonBody 但不共用） */
function readDevLogBody(req: {
  on: (e: string, cb: (chunk?: unknown) => void) => void;
}): Promise<string> {
  return new Promise((promiseResolve, promiseReject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk ?? "");
      if (raw.length > DEVLOG_BODY_LIMIT) promiseReject(new Error("body too large"));
    });
    req.on("end", () => promiseResolve(raw));
    req.on("error", () => promiseReject(new Error("read error")));
  });
}

function serveDevLog(): Plugin {
  // 会话名 = 本 dev server 实例的启动时间。**必须在 configureServer 内求值**：
  // 该钩子每次 server 启动都会跑（含配置变更触发的原地重启），而本插件的
  // 工厂函数只在配置模块求值时跑一次——Node 缓存配置模块的话时间戳会变陈旧。
  let sessionFile = "";
  let ready = false;
  return {
    name: "serve-ystk-devlog",
    configureServer(server: ViteDevServer) {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      sessionFile = `session-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jsonl`;
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (pathname !== "/api/devlog" && pathname !== "/api/devlog/session") {
          return next();
        }
        // 取当前 dev server 的会话文件名（浏览器据此定名，实现启停绑定）
        if (pathname === "/api/devlog/session") {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "仅支持 GET" });
            return;
          }
          sendJson(res, 200, { ok: true, session: sessionFile });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "仅支持 POST" });
          return;
        }
        void (async () => {
          let body: DevLogBody;
          try {
            body = JSON.parse(await readDevLogBody(req)) as DevLogBody;
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
            return;
          }
          const file = typeof body.file === "string" ? body.file : "";
          const text = typeof body.text === "string" ? body.text : "";
          // 文件名白名单：只接受本功能生成的会话名，防路径穿越
          if (!/^session-\d{8}-\d{6}\.jsonl$/.test(file)) {
            sendJson(res, 400, { ok: false, error: `file 非法：${file || "(空)"}` });
            return;
          }
          // 只认当前会话：server 原地重启后旧标签页仍持旧名，回 409 + 新名，
          // 客户端换名重投（否则日志会被劈成两个文件，违背"启停绑定一个文件"）
          if (file !== sessionFile) {
            sendJson(res, 409, { ok: false, error: "会话已更换", session: sessionFile });
            return;
          }
          try {
            if (!ready) {
              const logsDir = resolve(DEVLOG_DIR, "logs");
              await mkdir(logsDir, { recursive: true });
              await mkdir(resolve(DEVLOG_DIR, "backup"), { recursive: true });
              ready = true;
              try {
                const names = (await readdir(logsDir))
                  .filter((n) => /^session-.*\.jsonl$/.test(n))
                  .sort();
                for (const name of names.slice(0, Math.max(0, names.length - DEVLOG_KEEP))) {
                  await rm(resolve(logsDir, name), { force: true });
                }
              } catch {
                /* 清理失败不影响写入 */
              }
            }
            await appendFile(resolve(DEVLOG_DIR, "logs", file), text, "utf8");
            sendJson(res, 200, { ok: true, session: sessionFile });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: (err as Error).message });
          }
        })();
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * 图库索引备份落盘（dev 中间件，2026-09-24 任务卡）
 *
 * 浏览器侧 app/backup.ts 对注册表中权限 granted 的图库逐个检查
 * .ystk 核心索引文件（meta.json / index.json / vectors.bin，不含
 * thumbs——可从原图重建）的 mtime/size，有变更才把内容 base64 传过来：
 *   POST /api/backup/check  { libraryId, files:[{path,mtime,size}] }
 *     → 与 manifest.json 比对 → { ok, changed }
 *   POST /api/backup/commit { libraryId, name, files:[{path,base64}],
 *                            manifest:[{path,mtime,size}] }
 *     → 两阶段写 devdata/backup/<libId>/latest/（覆盖式只留一代）
 *
 * 变更判定保守：size 或 mtime 任一不同即算变更——宁可多拷一代也不漏
 * 备份（云盘 mtime 抖动最多导致多一次拷贝，无正确性问题）。
 * 两阶段：先写全 latest.new/，全部成功后删旧 latest/ 再改名——
 * 避免半新半旧的混合代。
 * ------------------------------------------------------------------ */

/** 备份文件名白名单（与浏览器侧 BACKUP_FILES 一致） */
const BACKUP_FILE_NAMES = new Set(["meta.json", "index.json", "vectors.bin"]);
/** commit body 上限（B）：index.json 几十 MB，base64 后 +33%，留足 */
const BACKUP_BODY_LIMIT = 256 * 1024 * 1024;

interface BackupCheckBody {
  libraryId?: unknown;
  /** 图库本名（用于备份目录名；清洗不可用则回退 libraryId） */
  name?: unknown;
  files?: unknown;
}

interface BackupCommitBody {
  libraryId?: unknown;
  name?: unknown;
  files?: unknown;
  manifest?: unknown;
}

/** 大上限 body reader（check/commit 共用；不动既有 readJsonBody/readDevLogBody） */
function readLargeBody(req: {
  on: (e: string, cb: (chunk?: unknown) => void) => void;
}): Promise<string> {
  return new Promise((promiseResolve, promiseReject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk ?? "");
      if (raw.length > BACKUP_BODY_LIMIT) promiseReject(new Error("body too large"));
    });
    req.on("end", () => promiseResolve(raw));
    req.on("error", () => promiseReject(new Error("read error")));
  });
}

/** libraryId 校验（binding.randomLibraryId 固定格式 lib_ + 8 位 hex，防路径穿越） */
function isLibraryId(v: unknown): v is string {
  return typeof v === "string" && /^lib_[0-9a-f]{8}$/.test(v);
}

/**
 * 备份目录名 = 图库本名（用户 2026-09-24 口径：不要 lib_xxxxxxxx 哈希目录）。
 * 库名是用户可控字符串（源自目录句柄的 name），落成路径前必须清洗：
 * 去路径分隔符与 Windows 保留字符、归一空白、去首尾点/空格、限长 64。
 * 清洗后为空、全点号（`.` / `..`）或命中 Windows 设备名（CON/PRN/AUX/NUL/COM1…）
 * 时返回 null —— 调用方回退用 libraryId 作目录名（宁可丑，不可危险）。
 */
function safeDirName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw
    // 路径分隔符先打掉，杜绝 "../../x" 之类
    .replace(/[\\/]/g, "-")
    // Windows 保留字符
    .replace(/[<>:"|?*]/g, "")
    // 控制字符（C0 + DEL）逐个按码点剔除：用字符类写会触发 oxlint no-control-regex
    .split("")
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    // Windows 不允许目录名以点或空格结尾（首部点也一并去，避免隐藏目录与 ".." 变体）
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (s.length > 64) s = s.slice(0, 64).replace(/[.\s]+$/, "");
  if (!s || /^\.+$/.test(s)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) return null;
  return s;
}

/** 校验并整理清单：[{path,mtime,size}]（path 白名单；mtime/size 必须是有限数） */
function parseManifestFiles(v: unknown): Array<{ path: string; mtime: number; size: number }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ path: string; mtime: number; size: number }> = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return null;
    const path = (item as { path?: unknown }).path;
    const mtime = (item as { mtime?: unknown }).mtime;
    const size = (item as { size?: unknown }).size;
    if (
      typeof path !== "string" || !BACKUP_FILE_NAMES.has(path) ||
      typeof mtime !== "number" || !Number.isFinite(mtime) ||
      typeof size !== "number" || !Number.isFinite(size)
    ) {
      return null;
    }
    out.push({ path, mtime, size });
  }
  return out;
}

/** 校验 commit 的文件负载：[{path,base64}]（path 白名单；base64 必须是非空字符串） */
function parsePayloadFiles(v: unknown): Array<{ path: string; base64: string }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ path: string; base64: string }> = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return null;
    const path = (item as { path?: unknown }).path;
    const base64 = (item as { base64?: unknown }).base64;
    if (typeof path !== "string" || !BACKUP_FILE_NAMES.has(path)) return null;
    if (typeof base64 !== "string") return null;
    out.push({ path, base64 });
  }
  return out;
}

function serveYstkBackup(): Plugin {
  return {
    name: "serve-ystk-backup",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (pathname !== "/api/backup/check" && pathname !== "/api/backup/commit") {
          return next();
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "仅支持 POST" });
          return;
        }
        void (async () => {
          let body: BackupCheckBody & BackupCommitBody;
          try {
            body = JSON.parse(await readLargeBody(req)) as BackupCheckBody & BackupCommitBody;
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
            return;
          }
          if (!isLibraryId(body.libraryId)) {
            sendJson(res, 400, { ok: false, error: "libraryId 非法" });
            return;
          }
          // 目录名优先用图库本名（清洗后）；不可用则回退 libraryId
          const dirName = safeDirName(body.name) ?? body.libraryId;
          const libDir = resolve(DEVLOG_DIR, "backup", dirName);

          if (pathname === "/api/backup/check") {
            const files = parseManifestFiles(body.files);
            if (!files) {
              sendJson(res, 400, { ok: false, error: "files 清单非法" });
              return;
            }
            let changed = true;
            try {
              const raw = await readFile(resolve(libDir, "manifest.json"), "utf8");
              const manifest = JSON.parse(raw) as {
                files?: Array<{ path: string; mtime: number; size: number }>;
              };
              const prev = manifest.files;
              // 保守比对：清单长度或任一文件的 size/mtime 不同即变更
              changed =
                !Array.isArray(prev) ||
                prev.length !== files.length ||
                files.some((f) => {
                  const p = prev.find((x) => x.path === f.path);
                  return !p || p.size !== f.size || p.mtime !== f.mtime;
                });
            } catch {
              /* manifest 不存在/损坏 → 首次备份，changed 保持 true */
            }
            sendJson(res, 200, { ok: true, changed, dir: dirName });
            return;
          }

          // ---- commit ----
          const name = typeof body.name === "string" ? body.name : "";
          // 注意：files 装的是 {path,base64} 负载，不能用 parseManifestFiles 校验
          const payloads = parsePayloadFiles(body.files);
          const manifest = parseManifestFiles(body.manifest);
          if (!payloads || !manifest || payloads.length === 0) {
            sendJson(res, 400, { ok: false, error: "files/manifest 清单非法" });
            return;
          }
          try {
            const staging = resolve(libDir, "latest.new");
            const latest = resolve(libDir, "latest");
            await rm(staging, { recursive: true, force: true });
            await mkdir(staging, { recursive: true });
            for (const item of payloads) {
              await writeFile(resolve(staging, item.path), Buffer.from(item.base64, "base64"));
            }
            await rm(latest, { recursive: true, force: true });
            await rename(staging, latest);
            await writeFile(
              resolve(libDir, "manifest.json"),
              JSON.stringify({ at: Date.now(), libraryId: body.libraryId, name, files: manifest }, null, 2),
              "utf8",
            );
            sendJson(res, 200, {
              ok: true,
              dir: `devdata/backup/${dirName}/latest`,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: (err as Error).message });
          }
        })();
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * 识图供应商代理（dev 中间件，2026-09-26 任务卡）
 *
 * 自定义供应商（OpenAI 兼容）的识图请求经本机 Node 转发，规避浏览器 CORS：
 *   POST /api/vision { url, apiKey, body }
 * 中间件加 Authorization: Bearer 头后转发到 url，状态码与响应体原样透传。
 * 仅 dev 生效；vite preview / 静态站无此端点 → 自定义供应商报错提示（直连回退不做，
 * 用户口径：代理为主）。
 * ------------------------------------------------------------------ */

/** 代理 body 上限：压缩档位最高 original，base64 后可到十几 MB */
const VISION_PROXY_BODY_LIMIT = 32 * 1024 * 1024;
/** 转发超时（ms）：略宽于前端 60s 请求超时，让前端先超时 */
const VISION_PROXY_TIMEOUT_MS = 70_000;

function serveVisionProxy(): Plugin {
  return {
    name: "serve-ystk-vision-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0];
        if (pathname !== "/api/vision") return next();
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "仅支持 POST" });
          return;
        }
        void (async () => {
          let raw = "";
          try {
            raw = await new Promise<string>((promiseResolve, promiseReject) => {
              req.on("data", (chunk) => {
                raw += String(chunk ?? "");
                if (raw.length > VISION_PROXY_BODY_LIMIT) {
                  promiseReject(new Error("body too large"));
                }
              });
              req.on("end", () => promiseResolve(raw));
              req.on("error", () => promiseReject(new Error("read error")));
            });
          } catch {
            sendJson(res, 413, { ok: false, error: "请求体过大" });
            return;
          }
          let body: { url?: unknown; apiKey?: unknown; body?: unknown };
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" });
            return;
          }
          const target =
            typeof body.url === "string" && /^https:\/\//.test(body.url)
              ? body.url
              : "";
          if (!target) {
            sendJson(res, 400, { ok: false, error: "url 非法（须 https://）" });
            return;
          }
          if (typeof body.apiKey !== "string" || typeof body.body !== "object") {
            sendJson(res, 400, { ok: false, error: "apiKey / body 缺失" });
            return;
          }
          try {
            const upstream = await fetch(target, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${body.apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body.body),
              signal: AbortSignal.timeout(VISION_PROXY_TIMEOUT_MS),
            });
            const text = await upstream.text();
            res.statusCode = upstream.status;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(text);
          } catch (err) {
            // 只回错误摘要，绝不回显 apiKey（安全红线）
            sendJson(res, 502, {
              ok: false,
              error: `转发失败：${(err as Error).message}`,
            });
          }
        })();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    serveSuperResOrtJs(),
    serveRevealInFolder(),
    serveLibraryPaths(),
    serveSystemComponents(),
    serveDevLog(),
    serveYstkBackup(),
    serveVisionProxy(),
  ],
  resolve: {
    // onnxruntime-web 的“外部 WASM”加载器（配合 ort.env.wasm.wasmPaths 使用）
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },
});
