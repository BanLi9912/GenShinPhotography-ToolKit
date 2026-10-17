/** 图库索引备份：ID 隔离、同库串行、完整代提交、保留 latest + 两代历史。 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface BackupFileStat {
  path: string;
  mtime: number;
  size: number;
}

interface Manifest {
  version: 2;
  libraryId: string;
  name: string;
  at: number;
  files: BackupFileStat[];
}

const FILE_NAMES = new Set(["meta.json", "index.json", "vectors.bin"]);
const GENERATION_NAME = /^generation-\d{13}-[0-9a-f-]{36}$/;

function safeName(raw: string): string {
  const name = raw.replace(/[\\/<>:"|?*]/g, "-").split("")
    .filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127)
    .join("").replace(/\s+/g, " ").trim().slice(0, 64).replace(/[.\s]+$/, "");
  return name || "图库";
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function parseFiles(raw: unknown): BackupFileStat[] {
  if (!Array.isArray(raw)) throw new Error("备份文件清单非法");
  const seen = new Set<string>();
  const files = raw.map((item) => {
    if (!item || typeof item.path !== "string" || !FILE_NAMES.has(item.path) ||
      seen.has(item.path) || !Number.isFinite(item.mtime) || item.mtime < 0 ||
      !Number.isSafeInteger(item.size) || item.size < 0) {
      throw new Error("备份文件清单非法或有重复项");
    }
    seen.add(item.path);
    return { path: item.path, mtime: item.mtime, size: item.size };
  });
  if (!seen.has("meta.json") || !seen.has("index.json")) {
    throw new Error("缺少 meta.json 或 index.json，未替换已有备份");
  }
  return files;
}

/** manifest 是最后写入的完成标记；读取时检查归属和每个文件是否完整。 */
async function readManifest(dir: string, libraryId: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.version !== 2 || manifest.libraryId !== libraryId) throw new Error("备份归属不符");
  const files = parseFiles(manifest.files);
  for (const file of files) {
    if ((await stat(resolve(dir, file.path))).size !== file.size) throw new Error("备份文件不完整");
  }
  return { ...manifest, files };
}

export function createLibraryBackupStore(root: string) {
  const chains = new Map<string, Promise<unknown>>();

  async function directory(libraryId: string, name: string): Promise<string> {
    await mkdir(root, { recursive: true });
    // 重命名图库后继续使用原目录，历史不会因显示名称改变而分散。
    const dirs = await readdir(root, { withFileTypes: true });
    const existing = dirs.find((d) => d.isDirectory() && d.name.endsWith(`--${libraryId}`));
    return existing?.name ?? `${safeName(name)}--${libraryId}`;
  }

  async function generations(history: string): Promise<string[]> {
    if (!(await exists(history))) return [];
    return (await readdir(history, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && GENERATION_NAME.test(d.name))
      .map((d) => d.name).sort().reverse();
  }

  async function recover(dir: string, libraryId: string): Promise<void> {
    const latest = resolve(dir, "latest");
    if (await exists(latest)) return;
    const history = resolve(dir, "history");
    // 中断发生在旧代归档与新代改名之间：找最近完整代恢复 latest。
    for (const name of await generations(history)) {
      const candidate = resolve(history, name);
      try { await readManifest(candidate, libraryId); }
      catch { continue; }
      await rename(candidate, latest);
      return;
    }
  }

  async function run(body: { libraryId?: unknown; name?: unknown; files?: unknown; manifest?: unknown }, commit: boolean) {
    if (typeof body.libraryId !== "string" || !/^lib_[0-9a-f]{8}$/.test(body.libraryId)) {
      throw new Error("libraryId 非法");
    }
    const libraryId = body.libraryId;
    const previous = chains.get(libraryId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const name = typeof body.name === "string" ? body.name : "";
      const dirName = await directory(libraryId, name);
      const dir = resolve(root, dirName);
      await recover(dir, libraryId);
      const latest = resolve(dir, "latest");
      const files = parseFiles(commit ? body.manifest : body.files);
      if (!commit) {
        let changed = true;
        try {
          const prev = await readManifest(latest, libraryId);
          changed = prev.files.length !== files.length || files.some((file) => {
            const old = prev.files.find((f) => f.path === file.path);
            return !old || old.mtime !== file.mtime || old.size !== file.size;
          });
        } catch { /* 缺失/损坏的备份需要重建，不把它误判成“无变化”。 */ }
        return { ok: true, changed, dir: dirName };
      }

      if (!Array.isArray(body.files) || body.files.length !== files.length) throw new Error("备份负载与清单不匹配");
      const payloads = new Map<string, Buffer>();
      for (const item of body.files) {
        if (!item || typeof item.path !== "string" || !FILE_NAMES.has(item.path) ||
          typeof item.base64 !== "string" || payloads.has(item.path)) {
          throw new Error("备份负载非法");
        }
        const bytes = Buffer.from(item.base64, "base64");
        if (bytes.toString("base64") !== item.base64) throw new Error("备份 base64 内容非法");
        if (files.find((f) => f.path === item.path)?.size !== bytes.length) throw new Error("备份内容大小与清单不匹配");
        payloads.set(item.path, bytes);
      }
      const meta = JSON.parse(payloads.get("meta.json")!.toString("utf8")) as { libraryId?: unknown };
      if (meta.libraryId !== libraryId || !Array.isArray(JSON.parse(payloads.get("index.json")!.toString("utf8")))) {
        throw new Error("备份索引格式或图库归属不符");
      }
      const history = resolve(dir, "history");
      const token = `generation-${Date.now()}-${randomUUID()}`;
      const staging = resolve(dir, `${token}.pending`);
      const archived = resolve(history, token);
      let movedOld = false;
      let published = false;
      await mkdir(staging, { recursive: true });
      try {
        for (const [path, bytes] of payloads) await writeFile(resolve(staging, path), bytes);
        const manifest: Manifest = { version: 2, libraryId, name, at: Date.now(), files };
        await writeFile(resolve(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
        if (await exists(latest)) {
          await mkdir(history, { recursive: true });
          await rename(latest, archived); // 先保住上一代，绝不先删。
          movedOld = true;
        }
        await rename(staging, latest);
        published = true;
      } catch (err) {
        if (movedOld && !(await exists(latest))) {
          try { await rename(archived, latest); }
          catch { /* 下次请求 recover；旧代完整保留在 history。 */ }
        }
        throw err;
      } finally {
        if (!published) await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      // 清理仅在新代已提交后进行；失败最多多留历史，不影响已成功的备份。
      try {
        for (const old of (await generations(history)).slice(2)) {
          await rm(resolve(history, old), { recursive: true, force: true });
        }
      } catch (err) { console.warn("[backup] 历史代清理失败，已保留额外副本", err); }
      return { ok: true, dir: dirName };
    });
    chains.set(libraryId, operation);
    try { return await operation; }
    finally { if (chains.get(libraryId) === operation) chains.delete(libraryId); }
  }
  return { run };
}
