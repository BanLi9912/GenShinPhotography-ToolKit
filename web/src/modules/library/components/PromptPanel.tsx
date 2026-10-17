import { useEffect, useMemo, useState } from "react";
import type { LibrarySettings } from "../index/indexFile";
import { resolveEnabledFields } from "../vision/fieldSchema";
import { buildPrompt, TEMPLATE_HEAD, TEMPLATE_TAIL } from "../vision/prompt";

/**
 * 识图提示词窗口（2026-09-26 任务卡；2026-10-03 改为直改式）。
 * - 预览：完整拼装提示词（HEAD + 字段行 + TAIL），只读，随字段配置与覆盖实时刷新；
 * - 编辑（直改式，2026-10-03 用户口径「把开头和结尾两段放在文本框里，便于修改和添加」）：
 *   框内即**当前生效段**——有覆盖存值显示存值，否则显示默认模板全文（`TEMPLATE_HEAD`/
 *   `TEMPLATE_TAIL`），用户在原文上直接改动或追加；
 *   onBlur 即改即存：草稿与默认模板严格相等时存 ""（保持跟随默认，不落快照），
 *   否则原样存草稿（含首尾空白也照存，`buildPrompt` 对纯空白已有回落）；
 *   「恢复默认」= 草稿重置为默认模板 + 清空存值；
 *   字段行不可编辑（由字段配置 UI 管理，永不脱钩——用户拍板口径）；
 * - 动画：进场 is-entered 滑入 / 退场由父级 leaving 控制（见 CSS）。
 */
export function PromptPanel({
  top,
  right,
  width,
  maxHeight,
  entered,
  lib,
  patchLib,
}: {
  top: number;
  right: number;
  width: number;
  maxHeight: number;
  /** 进场标记：挂载后双 rAF 置 true（父级传入） */
  entered: boolean;
  lib: LibrarySettings;
  patchLib: (patch: Partial<LibrarySettings>) => void;
}) {
  // 草稿 = 当前生效段（有覆盖显示覆盖，没有则显示默认模板全文）
  const effectiveHead = lib.promptHead?.trim() ? lib.promptHead : TEMPLATE_HEAD;
  const effectiveTail = lib.promptTail?.trim() ? lib.promptTail : TEMPLATE_TAIL;
  const [headDraft, setHeadDraft] = useState(effectiveHead);
  const [tailDraft, setTailDraft] = useState(effectiveTail);

  // 面板重开 / 库切换时草稿跟随现值（lib 引用变化即重置草稿）——同样用生效段
  useEffect(() => {
    setHeadDraft(lib.promptHead?.trim() ? lib.promptHead : TEMPLATE_HEAD);
    setTailDraft(lib.promptTail?.trim() ? lib.promptTail : TEMPLATE_TAIL);
  }, [lib]);

  /** 完整预览：覆盖生效后的最终提示词 */
  const preview = useMemo(
    () =>
      buildPrompt(resolveEnabledFields(lib.fieldConfig), {
        head: lib.promptHead,
        tail: lib.promptTail,
      }),
    [lib],
  );

  return (
    <div
      className={"lib-prompt" + (entered ? " is-entered" : "")}
      style={{ top, right, width, maxHeight }}
      onClick={(e) => e.stopPropagation()}
    >
      <header className="lib-prompt__head">
        <span className="lib-prompt__title">识图提示词</span>
        <span className="lib-prompt__sub">字段部分由「字段配置」自动生成</span>
      </header>
      <label className="lib-prompt__block">
        <span className="lib-prompt__label">完整预览（只读）</span>
        <textarea className="lib-prompt__preview" rows={12} readOnly value={preview} />
      </label>
      <label className="lib-prompt__block">
        <span className="lib-prompt__label">开头（角色设定 / 观察流程）</span>
        <textarea
          className="lib-prompt__edit"
          rows={6}
          value={headDraft}
          onChange={(e) => setHeadDraft(e.target.value)}
          onBlur={() =>
            patchLib({ promptHead: headDraft === TEMPLATE_HEAD ? "" : headDraft })
          }
        />
        <button
          type="button"
          className="lib-settings__mini-btn"
          onClick={() => {
            setHeadDraft(TEMPLATE_HEAD);
            patchLib({ promptHead: "" });
          }}
        >
          恢复默认
        </button>
      </label>
      <label className="lib-prompt__block">
        <span className="lib-prompt__label">结尾（质量要求 / 示例 / 格式规则）</span>
        <textarea
          className="lib-prompt__edit"
          rows={8}
          value={tailDraft}
          onChange={(e) => setTailDraft(e.target.value)}
          onBlur={() =>
            patchLib({ promptTail: tailDraft === TEMPLATE_TAIL ? "" : tailDraft })
          }
        />
        <button
          type="button"
          className="lib-settings__mini-btn"
          onClick={() => {
            setTailDraft(TEMPLATE_TAIL);
            patchLib({ promptTail: "" });
          }}
        >
          恢复默认
        </button>
      </label>
      <p className="lib-prompt__hint">
        修改即时保存到当前图库（.ystk/meta.json）；对存量图片生效需「全库重跑」。
      </p>
    </div>
  );
}
