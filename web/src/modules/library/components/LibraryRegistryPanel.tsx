/**
 * 设置中心 M3 分区 · 图库注册表管理（2026-09-08 用户需求）：
 *
 * 浏览器注册表（idb `libraries` 表）只存句柄与目录名，不含磁盘路径——「在文件夹中
 * 打开」需要 libraryId → 绝对路径的映射。本区块把登记入口挂在**每个图库行上**，
 * 并就地展示该图库已登记的路径：
 *
 *   - 未登记 → 行内「登记路径」展开输入框，填该图库的目录绝对路径即可。
 *   - 已登记 → 直接显示路径 + 来源徽章（已登记 / 自动记住），可「重新登记 / 删除登记」。
 *   - 「移除」按来源分流：本机注册过 → store.unbind（移除 idb 记录，**不删磁盘 .ystk**）；
 *     仅登记了路径 → 只删登记表里那条。
 *
 * 路径的真伪由 Node 侧（dev server 中间件）校验：目录必须存在、含 `.ystk/meta.json`、
 * 且 meta.json 里的 libraryId 与本行图库一致，否则拒绝登记并回具体原因。
 * （浏览器句柄只能给目录名、给不出路径，所以路径必须由用户提供。）
 *
 * 识图全局设置区块由 GlobalSettingsPanel 用横线（.lib-settings__section 的
 * border-top）与本区块隔开。
 */
import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "../../../ui/confirm";
import { toast } from "../../../ui/toast";
import { useLibraryStore } from "../store";
import {
  deleteLibraryPath,
  fetchLibraryPaths,
  saveLibraryPath,
  type LibraryPathEntry,
} from "./revealInFolder";

export function LibraryRegistryPanel() {
  const libraries = useLibraryStore((s) => s.libraries);
  const unbind = useLibraryStore((s) => s.unbind);
  const [paths, setPaths] = useState<LibraryPathEntry[]>([]);
  const [pathError, setPathError] = useState<string | null>(null);
  /** 正在编辑的行（同一时刻只允许一行）；null = 全部收起 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetchLibraryPaths();
    if (res.ok) {
      setPaths(res.entries);
      setPathError(null);
    } else {
      setPaths([]);
      setPathError(res.error);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pathOf = (libraryId: string): LibraryPathEntry | undefined =>
    paths.find((p) => p.libraryId === libraryId);

  /** 浏览器注册表行 + 仅登记了路径的行（本机未注册的图库也要能看/删） */
  const rows = [
    ...libraries.map((lib) => ({
      libraryId: lib.libraryId,
      name: lib.name,
      itemCount: lib.itemCount,
      registered: true,
    })),
    ...paths
      .filter((p) => !libraries.some((lib) => lib.libraryId === p.libraryId))
      .map((p) => ({
        libraryId: p.libraryId,
        name: p.path.split(/[\\/]/).filter(Boolean).pop() ?? p.libraryId,
        itemCount: null,
        registered: false,
      })),
  ];

  const closeEdit = () => {
    setEditingId(null);
    setInput("");
  };

  /** 展开某行输入框（已登记时预填现有路径，便于「重新登记」微调） */
  const openEdit = (row: { libraryId: string }) => {
    if (editingId === row.libraryId) {
      closeEdit();
      return;
    }
    setEditingId(row.libraryId);
    setInput(pathOf(row.libraryId)?.path ?? "");
  };

  /**
   * 粘贴路径的智能清理：资源管理器 Ctrl+Shift+C 复制出来的是带引号的
   * `"D:\照片\参考图"`，首尾引号（含中文全角引号、多次复制叠加）一律去掉。
   */
  const normalizePathInput = (value: string): string => {
    let out = value.trim();
    for (;;) {
      const next = out.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
      if (next === out) return out;
      out = next;
    }
  };

  /** 保存该行的路径登记：Node 侧校验目录存在 + meta.json 的 id 与本行一致 */
  const handleSave = (row: { libraryId: string; name: string }) => {
    const raw = normalizePathInput(input);
    if (!raw) {
      toast("请填写图库目录路径");
      return;
    }
    void (async () => {
      setBusyId(row.libraryId);
      const res = await saveLibraryPath(raw, row.libraryId);
      setBusyId(null);
      if (!res.ok) {
        toast(res.error ?? "登记失败");
        return;
      }
      closeEdit();
      await reload();
      toast(`已登记「${row.name}」的磁盘位置`);
    })();
  };

  /** 删除该行的路径登记（只删登记，不动图库） */
  const handleDeletePath = (row: { libraryId: string; name: string }) => {
    void (async () => {
      setBusyId(row.libraryId);
      const res = await deleteLibraryPath(row.libraryId);
      setBusyId(null);
      if (!res.ok) {
        toast(res.error ?? "删除登记失败");
        return;
      }
      await reload();
      toast(`已删除「${row.name}」的路径登记`);
    })();
  };

  /** 移除图库：本机注册过 → 解绑注册表；否则只删登记 */
  const handleRemove = (row: {
    libraryId: string;
    name: string;
    registered: boolean;
  }) => {
    void confirmDialog({
      title: "移除图库",
      message: row.registered
        ? `从本机注册表移除「${row.name}」？磁盘上的图库与 .ystk 索引不会被删除，之后重新绑定该文件夹即可恢复。`
        : `删除「${row.name}」的磁盘位置登记？仅删除这条记录，不影响图库本身。`,
      confirmText: "移除",
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      void (async () => {
        if (row.registered) await unbind(row.libraryId);
        await deleteLibraryPath(row.libraryId);
        await reload();
        toast(`已移除「${row.name}」`);
      })();
    });
  };

  return (
    <div>
      <div className="lib-settings__section-head">
        <span className="lib-settings__section-title">图库注册表</span>
      </div>
      <p className="lib-settings__hint">
        为每个图库登记磁盘位置后，「在文件夹中打开」直接使用该路径（无需扫盘）。
      </p>

      {pathError && <p className="lib-settings__hint lib-reg__error">{pathError}</p>}

      {rows.length === 0 ? (
        <p className="lib-settings__hint">本机还没有注册任何图库。</p>
      ) : (
        <ul className="lib-reg__list">
          {rows.map((row) => {
            const entry = pathOf(row.libraryId);
            const pathOk = !!entry && entry.exists;
            const isEditing = editingId === row.libraryId;
            const busy = busyId === row.libraryId;
            return (
              <li key={row.libraryId} className="lib-reg__row">
                <div className="lib-reg__main">
                  <span className="lib-reg__name">
                    {row.name}
                    {row.itemCount !== null && (
                      <span className="lib-reg__count">{row.itemCount} 张</span>
                    )}
                    {entry && (
                      <span
                        className={
                          "lib-reg__badge" +
                          (entry.source === "config" ? " is-config" : "")
                        }
                      >
                        {entry.source === "config" ? "已登记" : "自动记住"}
                      </span>
                    )}
                    {!row.registered && (
                      <span className="lib-reg__badge">未登记</span>
                    )}
                  </span>
                  <span
                    className={
                      "lib-reg__path" + (entry && !pathOk ? " is-missing" : "")
                    }
                    title={entry?.path ?? "尚未登记磁盘位置"}
                  >
                    {entry
                      ? `${entry.path}${pathOk ? "" : "（目录已不在）"}`
                      : "尚未登记磁盘位置"}
                  </span>
                </div>

                <div className="lib-reg__ops">
                  <button
                    type="button"
                    className="lib-settings__mini-btn"
                    disabled={busy}
                    onClick={() => openEdit(row)}
                  >
                    {entry ? "重新登记" : "登记路径"}
                  </button>
                  {entry && (
                    <button
                      type="button"
                      className="lib-settings__mini-btn"
                      disabled={busy}
                      onClick={() => handleDeletePath(row)}
                    >
                      删除登记
                    </button>
                  )}
                  <button
                    type="button"
                    className="lib-settings__mini-btn lib-reg__remove"
                    disabled={busy}
                    onClick={() => handleRemove(row)}
                  >
                    移除
                  </button>
                </div>

                {isEditing && (
                  <div className="lib-reg__manual">
                    <input
                      className="lib-settings__input lib-reg__input"
                      placeholder="图库目录绝对路径（资源管理器中选中文件夹按 Ctrl+Shift+C 可复制路径）"
                      value={input}
                      spellCheck={false}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSave(row);
                        if (e.key === "Escape") closeEdit();
                      }}
                    />
                    <button
                      type="button"
                      className="lib-settings__mini-btn"
                      disabled={busy}
                      onClick={() => handleSave(row)}
                    >
                      {busy ? "保存中…" : "保存"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
