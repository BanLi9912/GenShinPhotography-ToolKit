/**
 * 分享包拖入区（无按钮入口，用户 2026-11-21 口径）：把 .zip 分享包或 Eagle 的 .eaglepack
 * 从系统拖到图库页任意位置，
 * 松手即开始导入为新图库。
 *
 * 只接管**外部文件**拖入：本页面自己发起的拖拽（网格拖图去画布、标签排序、色块）
 * 在 dragstart 时记下，不显示遮罩、不拦截。Chrome 拖页面内 <img> 时 types 里也会带
 * "Files"，所以不能只看 types。外部文件一律 preventDefault——否则浏览器会直接打开
 * 或下载拖进来的文件，把用户带离工具箱。
 *
 * 拖放本身不算用户手势，目录选择器要等确认框里那次点击（见 store.importSharePackage）。
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "../../../ui/toast";
import { useLibraryStore } from "../store";

const ACCEPT_PHASES = new Set(["unbound", "ready", "missing", "need-permission"]);

function pickPackage(files: FileList | null): File | null {
  if (!files || files.length === 0) {
    toast("请拖入分享包（.zip）或 Eagle 导出包（.eaglepack）");
    return null;
  }
  if (files.length > 1) {
    toast("一次拖入一个分享包");
    return null;
  }
  const file = files[0];
  const name = file.name.toLowerCase();
  if (name.endsWith(".rar") || name.endsWith(".7z")) {
    toast("请先解压，或重新导出为 .zip / .eaglepack");
    return null;
  }
  if (!name.endsWith(".zip") && !name.endsWith(".eaglepack")) {
    toast("可导入 .zip 分享包或 Eagle 的 .eaglepack。往图库里加图片：把图片放进图库文件夹后点「重新扫描」");
    return null;
  }
  return file;
}

export function SharePackageDrop() {
  const enabled = useLibraryStore(
    (s) => ACCEPT_PHASES.has(s.phase) && s.sharing == null && !s.scan.running,
  );
  const [over, setOver] = useState(false);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) setOver(false);
  }, [enabled]);

  useEffect(() => {
    let depth = 0;
    let internal = false;

    const isExternalFileDrag = (e: DragEvent): boolean =>
      !internal && !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const reset = () => {
      depth = 0;
      setOver(false);
    };

    const onDragStart = () => {
      internal = true;
    };
    const onDragEnd = () => {
      internal = false;
      reset();
    };
    // 拖拽期间不产生指针按下：一旦有 pointerdown，上一次拖拽必然已结束（兜住源元素
    // 卸载导致 dragend 没触发的情况）
    const onPointerDown = () => {
      internal = false;
    };
    const onDragEnter = (e: DragEvent) => {
      if (!isExternalFileDrag(e)) return;
      e.preventDefault();
      depth += 1;
      if (enabledRef.current) setOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!isExternalFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = enabledRef.current ? "copy" : "none";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isExternalFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isExternalFileDrag(e)) {
        internal = false;
        return;
      }
      e.preventDefault();
      reset();
      if (!enabledRef.current) {
        const st = useLibraryStore.getState();
        toast(st.sharing != null ? "请等当前的导入或导出完成" : "扫描完成后可导入分享包");
        return;
      }
      const file = pickPackage(e.dataTransfer?.files ?? null);
      if (file) void useLibraryStore.getState().importSharePackage(file);
    };

    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  if (!over) return null;
  return createPortal(
    <div className="lib-sharedrop" aria-hidden="true">
      <div className="lib-sharedrop__card">
        <div className="lib-sharedrop__title">松手导入图库包</div>
        <div className="lib-sharedrop__hint">分享包（.zip）或 Eagle 导出包（.eaglepack）会解压成一个新图库，位置下一步选择</div>
      </div>
    </div>,
    document.body,
  );
}
