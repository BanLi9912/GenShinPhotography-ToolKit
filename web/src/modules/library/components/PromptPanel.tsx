import { useEffect, useMemo, useState } from "react";
import type { LibrarySettings } from "../index/indexFile";
import { resolveEnabledFields } from "../vision/fieldSchema";
import { buildPrompt } from "../vision/prompt";

/**
 * 识图提示词窗口（2026-09-26 任务卡）：设置面板左侧浮层。
 * - 预览：完整拼装提示词（HEAD + 字段行 + TAIL），只读，随字段配置与覆盖实时刷新；
 * - 编辑：开头/结尾两段覆盖，onBlur 即改即存（口径同词表编辑），留空 = 用默认；
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
  const [headDraft, setHeadDraft] = useState(lib.promptHead ?? "");
  const [tailDraft, setTailDraft] = useState(lib.promptTail ?? "");

  // 面板重开 / 库切换时草稿跟随现值（lib 引用变化即重置草稿）
  useEffect(() => {
    setHeadDraft(lib.promptHead ?? "");
    setTailDraft(lib.promptTail ?? "");
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
        <span className="lib-prompt__label">
          开头覆盖（角色设定 / 观察流程；留空用默认）
        </span>
        <textarea
          className="lib-prompt__edit"
          rows={6}
          placeholder="留空使用默认开头"
          value={headDraft}
          onChange={(e) => setHeadDraft(e.target.value)}
          onBlur={() => patchLib({ promptHead: headDraft })}
        />
        <button
          type="button"
          className="lib-settings__mini-btn"
          onClick={() => {
            setHeadDraft("");
            patchLib({ promptHead: "" });
          }}
        >
          恢复默认
        </button>
      </label>
      <label className="lib-prompt__block">
        <span className="lib-prompt__label">
          结尾覆盖（质量要求 / 示例 / 格式规则；留空用默认）
        </span>
        <textarea
          className="lib-prompt__edit"
          rows={8}
          placeholder="留空使用默认结尾"
          value={tailDraft}
          onChange={(e) => setTailDraft(e.target.value)}
          onBlur={() => patchLib({ promptTail: tailDraft })}
        />
        <button
          type="button"
          className="lib-settings__mini-btn"
          onClick={() => {
            setTailDraft("");
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
