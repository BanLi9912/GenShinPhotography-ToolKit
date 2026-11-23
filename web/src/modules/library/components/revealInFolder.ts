/**
 * 「在文件夹中打开」及其配套的图库磁盘位置登记（2026-09-08 用户需求）：
 *
 * - `revealInFolder`：详情页动作钮调用。浏览器侧只有图库 id 与库内相对路径
 *   （`LibraryIndexItem.relPath`），绝对路径由 dev server 的 Node 中间件反查后
 *   调 explorer /select 弹出资源管理器并单击选中该图（见 vite.config.ts）。
 * - `fetchLibraryPaths` / `saveLibraryPath` / `deleteLibraryPath`：设置中心
 *   「图库注册表」区块用。登记表落在 `web/.ystk-library-paths.json`（已 gitignore），
 *   有登记时反查 0 秒命中，不再扫盘。
 *
 * 注意：浏览器句柄只给目录名、给不出绝对路径，所以登记时的路径必须由用户提供；
 * 真伪由 Node 侧校验（目录存在 + 含 `.ystk/meta.json` + libraryId 与目标图库一致）。
 *
 * 全部只在 dev 生效：生产构建没有 Node 进程可依托，调用直接返回失败并给出提示。
 */

export interface RevealInFolderResult {
  ok: boolean;
  /** 解析到的绝对路径（失败时为空） */
  path?: string;
  /** 失败原因（直接可展示给用户） */
  error?: string;
}

export interface LibraryPathEntry {
  libraryId: string;
  path: string;
  /** config = 用户在设置里登记；scan = 扫盘命中自动记住 */
  source: "config" | "scan";
  addedAt: number;
  /** 目录当前是否还在磁盘上（GET 时由 Node 侧校验） */
  exists: boolean;
}

const REVEAL_ENDPOINT = "/__ystk/reveal";
const PATHS_ENDPOINT = "/__ystk/library-paths";

/** 无 dev 中间件时的统一提示（生产/预览构建） */
const NO_MIDDLEWARE_HINT =
  "该功能依赖本地 dev server（Node 侧才能读到磁盘绝对路径），请用 scripts\\start-web.bat 启动后再试";

async function postJson(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; data: unknown; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as
      | (Record<string, unknown> & { ok?: unknown; error?: unknown })
      | null;
    if (data && typeof data.ok === "boolean") {
      return {
        ok: data.ok,
        data,
        error: typeof data.error === "string" ? data.error : undefined,
      };
    }
    return { ok: false, data: null, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: `${(err as Error).message}（dev server 是否在运行？）`,
    };
  }
}

export async function revealInFolder(options: {
  libraryId: string;
  libraryName: string;
  relPath: string;
}): Promise<RevealInFolderResult> {
  if (!import.meta.env.DEV) return { ok: false, error: NO_MIDDLEWARE_HINT };
  const { ok, data, error } = await postJson(REVEAL_ENDPOINT, {
    libraryId: options.libraryId,
    libraryName: options.libraryName,
    relPath: options.relPath,
  });
  if (!ok) return { ok: false, error: error ?? "定位失败" };
  const payload = data as RevealInFolderResult;
  return { ok: true, path: payload.path };
}

/** 读登记表（含目录是否仍在） */
export async function fetchLibraryPaths(): Promise<
  { ok: true; entries: LibraryPathEntry[] } | { ok: false; error: string }
> {
  if (!import.meta.env.DEV) return { ok: false, error: NO_MIDDLEWARE_HINT };
  try {
    const res = await fetch(PATHS_ENDPOINT);
    const data = (await res.json().catch(() => null)) as
      | { ok?: unknown; entries?: unknown }
      | null;
    if (!data || data.ok !== true || !Array.isArray(data.entries)) {
      return { ok: false, error: `读取登记表失败（HTTP ${res.status}）` };
    }
    return { ok: true, entries: data.entries as LibraryPathEntry[] };
  } catch (err) {
    return {
      ok: false,
      error: `读取登记表失败：${(err as Error).message}（dev server 是否在运行？）`,
    };
  }
}

/**
 * 登记一条路径：Node 侧校验目录存在、含 `.ystk/meta.json`，并**从目录里读出
 * libraryId**（传 `libraryId` 时额外校验是否一致，用于「选择目录」后的对位确认）。
 */
export async function saveLibraryPath(
  path: string,
  libraryId?: string,
): Promise<{ ok: boolean; libraryId?: string; error?: string }> {
  if (!import.meta.env.DEV) return { ok: false, error: NO_MIDDLEWARE_HINT };
  const { ok, data, error } = await postJson(PATHS_ENDPOINT, {
    path,
    ...(libraryId ? { libraryId } : {}),
  });
  if (!ok) return { ok: false, error: error ?? "登记失败" };
  const entry = (data as { entry?: { libraryId?: unknown } } | null)?.entry;
  return {
    ok: true,
    libraryId: typeof entry?.libraryId === "string" ? entry.libraryId : undefined,
  };
}

/** 删除一条登记（只删登记，不动浏览器注册表与磁盘图库） */
export async function deleteLibraryPath(
  libraryId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!import.meta.env.DEV) return { ok: false, error: NO_MIDDLEWARE_HINT };
  try {
    const res = await fetch(
      `${PATHS_ENDPOINT}?libraryId=${encodeURIComponent(libraryId)}`,
      { method: "DELETE" },
    );
    const data = (await res.json().catch(() => null)) as
      | { ok?: unknown; error?: unknown }
      | null;
    if (data && data.ok === true) return { ok: true };
    return {
      ok: false,
      error:
        typeof data?.error === "string" ? data.error : `删除失败（HTTP ${res.status}）`,
    };
  } catch (err) {
    return { ok: false, error: `删除失败：${(err as Error).message}` };
  }
}
