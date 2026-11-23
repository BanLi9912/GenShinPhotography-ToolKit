/**
 * M3 识图设置 · 图库区面板（D6 两级：任务 2026-09-08 起全局区迁入设置中心 M3 分区，
 * 本面板只剩「当前图库」，即改即存无保存按钮）：
 * 图库区（meta.json settings）：配置变更全库重跑 / 压缩档位 / 分析预设 / 字段配置 /
 * 词表编辑 / 自定义字段。
 * 浮层外点击/Esc 关闭（Esc stopPropagation，与 FilterBar 同款）；
 * 锚工具栏岛下方右侧：以工具栏岛 rect 定位（面板不从属工具栏 DOM 子树，
 * design.md §7.11 规避 Backdrop Root），最大高度按视口动态收缩（不伸到界面外）。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { getSettings, updateSettings } from "../index/indexFile";
import type { LibrarySettings } from "../index/indexFile";
import { useLibraryStore } from "../store";
import { confirmDialog } from "../../../ui/confirm";
import {
  BUILTIN_FIELDS,
  type CustomFieldDef,
  type FieldConfig,
} from "../vision/fieldSchema";
import { getPreset, VISION_PRESETS } from "../vision/presets";
import { PromptPanel } from "./PromptPanel";

/** 内置字段中文名（任务卡 4.9 逐字钉死） */
const FIELD_LABELS: Record<string, string> = {
  description: "描述",
  subject: "主体",
  scene: "场景",
  lighting: "光线",
  angle: "视角",
  composition: "构图",
  shot: "景别",
  color_mood: "色彩倾向",
  mood_style: "情绪风格",
  tags: "标签",
  content_type: "内容类型",
};

/** 词表可编辑的内置枚举字段 */
const VOCAB_FIELDS = ["angle", "composition", "shot"] as const;

/** 词表分隔符统一为：中文逗号/英文逗号/顿号/斜杠/换行 任一 */
function splitList(text: string): string[] {
  return text
    .split(/[,，、/\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 生效词表：fieldConfig.options 覆盖优先（非空才生效），否则内置默认 */
function effectiveVocab(key: string, ls: LibrarySettings): string[] {
  const cfg = (ls.fieldConfig ?? {}) as FieldConfig;
  const arr = cfg.options?.[key];
  if (arr && arr.length > 0) return arr;
  return BUILTIN_FIELDS.find((f) => f.key === key)?.options ?? [];
}

function initialVocabs(ls: LibrarySettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of VOCAB_FIELDS) out[key] = effectiveVocab(key, ls).join("，");
  return out;
}

function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lib-settings__row">
      <span className="lib-settings__label">{label}</span>
      {children}
    </div>
  );
}

export function SettingsPanel({
  toolbarRef,
}: {
  toolbarRef: RefObject<HTMLDivElement | null>;
}) {
  const open = useLibraryStore((s) => s.settingsOpen);
  const setSettingsOpen = useLibraryStore((s) => s.setSettingsOpen);
  const rerunVisionAll = useLibraryStore((s) => s.rerunVisionAll);

  /** 下拉弹出/收回动画：进入立即挂载，退出先播收回动画再卸载（口径同 FilterBar） */
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [lib, setLib] = useState<LibrarySettings | null>(null);
  const [vocabs, setVocabs] = useState<Record<string, string>>({});
  /** 图库区配置（压缩档位/预设/字段配置含词表与自定义字段）被用户改动；不跨会话记忆 */
  const [configDirty, setConfigDirty] = useState(false);
  const [customDraft, setCustomDraft] = useState<{
    key: string;
    label: string;
    type: CustomFieldDef["type"];
    hint: string;
    options: string;
  }>({ key: "", label: "", type: "string", hint: "", options: "" });
  const [customError, setCustomError] = useState("");
  /** 面板锚点（工具栏岛 rect 换算）；null 未测量不渲染 */
  const [rect, setRect] = useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);
  /** 提示词窗口开合（面板内局部态；面板关闭重开复位，不跨会话记忆——口径同 configDirty） */
  const [promptOpen, setPromptOpen] = useState(false);
  /** 提示窗进出场编排（口径同面板 mounted/leaving） */
  const [promptMounted, setPromptMounted] = useState(false);
  /** 提示窗正在收起（退场动画期间）：此时平移量立即归零，使面板与提示窗同步收起 */
  const [promptClosing, setPromptClosing] = useState(false);
  /** 收起时平移量归零的延后定时器（先让两窗淡完，再让面板横移回位） */
  const promptShiftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 提示窗进场标记（挂载首帧 false → 双 rAF 置 true，让 CSS 过渡真正跑起来；
      关闭时置回 false 播滑出，动画走完才卸载——口径同面板 leaving） */
  const [promptEntered, setPromptEntered] = useState(false);
  const promptLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 面板实际宽度（提示窗定位与平移量计算用；promptMounted 时测量） */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  /** 面板开合现值（供提示窗退场定时器判断"面板是否还开着"，避免把 open 写进依赖） */
  const openRef = useRef(false);

  useEffect(() => {
    if (open) {
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setMounted(false);
      setLeaving(false);
    }, 200);
    return () => {
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
    };
  }, [open, mounted]);

  // 提示词窗口进出场编排（口径同面板自身：进入立即挂载，退出播完动画再卸载）
  useEffect(() => {
    if (promptOpen) {
      if (promptLeaveTimer.current) {
        clearTimeout(promptLeaveTimer.current);
        promptLeaveTimer.current = null;
      }
      if (promptShiftTimer.current) {
        clearTimeout(promptShiftTimer.current);
        promptShiftTimer.current = null;
      }
      setPromptMounted(true);
      setPromptClosing(false);
      return;
    }
    if (!promptMounted) return;
    setPromptEntered(false); // 未进入态 = 淡出位（两窗一起原地渐变消失）
    /* 分两段收，避免"提示词窗口被面板盖住瞬间消失"：
       ① 0–180ms：面板与提示窗**同时原地淡出**（同一条 fade-out 动画，见 CSS）；
       ② 180ms：面板才开始横移回位（promptClosing → promptLayout.shift 归零）。
       ①② 顺序不能反：面板先横移会盖住提示窗（面板 z 序在后 + 玻璃），提示窗就"瞬间消失"了。
       面板本体关闭（open=false）时不再横移（② 由 openRef 拦掉），两窗直接一起向上淡出。 */
    promptShiftTimer.current = setTimeout(() => {
      promptShiftTimer.current = null;
      if (openRef.current) setPromptClosing(true);
    }, 180);
    promptLeaveTimer.current = setTimeout(() => {
      promptLeaveTimer.current = null;
      setPromptMounted(false);
    }, 180);
    return () => {
      if (promptShiftTimer.current) {
        clearTimeout(promptShiftTimer.current);
        promptShiftTimer.current = null;
      }
      if (promptLeaveTimer.current) {
        clearTimeout(promptLeaveTimer.current);
        promptLeaveTimer.current = null;
      }
    };
  }, [promptOpen, promptMounted]);

  // 打开时载入图库设置
  useEffect(() => {
    openRef.current = open;
    if (!open) return;
    const ls = getSettings();
    setLib(ls);
    setVocabs(initialVocabs(ls));
    setCustomError("");
    setConfigDirty(false); // 面板关闭重开不残留（不跨会话记忆）
    /* 提示窗随浮层一起走：**重开时**把提示窗状态一并复位（延迟到重开做，而不是关闭时做）。
       关闭时若立刻撤掉 promptMounted，平移量（promptLayout.shift）会在面板退场动画进行中
       就变 0 —— 面板会一边淡出上收一边向左滑回，观感不对；关闭时应保持原位置直接向上收起。
       而只在重开时复位，又正好避免"重开后先按已平移渲染、再滑回原位"（用户 2026-09-26 反馈）。 */
    if (promptLeaveTimer.current) {
      clearTimeout(promptLeaveTimer.current);
      promptLeaveTimer.current = null;
    }
    setPromptOpen(false);
    setPromptMounted(false);
    setPromptEntered(false);
  }, [open]);

  // Esc 关闭（stopPropagation 不冒泡到页面级，与 FilterBar 同款）；
  // 层级：提示窗开着先收提示窗，再按 Esc 才关设置面板（不得一次关两层）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (useLibraryStore.getState().settingsOpen && promptOpen) {
          setPromptOpen(false);
          return;
        }
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, promptOpen, setSettingsOpen]);

  // 锚点测量：面板定位在工具栏岛下方右侧（右缘对齐岛右缘、顶部在岛下沿 +8px）；
  // 最大高度 = 视口高 − 面板顶 − 底边距，避免伸到界面外；窗口 resize 与岛尺寸变化重测
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const measure = () => {
      const el = toolbarRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const top = r.bottom + 8;
      setRect({
        top,
        right: Math.max(8, window.innerWidth - r.right),
        maxHeight: Math.max(120, window.innerHeight - top - 16),
      });
    };
    measure();
    const el = toolbarRef.current;
    const observer = el ? new ResizeObserver(measure) : null;
    if (el && observer) observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, mounted, toolbarRef]);

  // 面板实测宽度（提示窗定位与面板平移量的基准）；仅在提示窗挂载时测一次：
  // banner 出现等后续宽度变化的场景不追测（需 ResizeObserver，违反改动最小化）
  useLayoutEffect(() => {
    if (!promptMounted) return;
    setPanelWidth(panelRef.current?.offsetWidth ?? 0);
  }, [promptMounted]);

  // 提示窗进场：挂载首帧保持未进入态，双 rAF 后置 true 触发 CSS 过渡（滑入）
  useEffect(() => {
    if (!promptMounted) {
      setPromptEntered(false);
      return;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPromptEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [promptMounted]);

  if (!mounted || !rect) return null;

  const patchLib = (patch: Partial<LibrarySettings>) => {
    setLib((prev) => (prev ? { ...prev, ...patch } : prev));
    updateSettings(patch);
    // 压缩档位/预设/字段配置（含词表、自定义字段）任何修改都经 patchLib，置脏标
    setConfigDirty(true);
  };

  const fc: FieldConfig = (lib?.fieldConfig ?? {}) as FieldConfig;
  const disabled = fc.disabled ?? [];
  const enabled = fc.enabled ?? [];
  const customs = fc.custom ?? [];

  /** 以现值构造 fieldConfig（Record 形态，供 updateSettings 写入） */
  const fieldConfigRecord = (
    over: Partial<FieldConfig>,
  ): Record<string, unknown> => ({
    disabled: over.disabled ?? disabled,
    enabled: over.enabled ?? enabled,
    options: over.options ?? fc.options,
    custom: over.custom ?? fc.custom,
  });

  /** 勾选口径：defaultEnabled 字段勾 = 不在 disabled；content_type 勾 = 在 enabled */
  const isFieldOn = (def: (typeof BUILTIN_FIELDS)[number]): boolean =>
    (def.defaultEnabled || enabled.includes(def.key)) &&
    !disabled.includes(def.key);

  const toggleField = (def: (typeof BUILTIN_FIELDS)[number]) => {
    if (!lib) return;
    const nextDisabled = [...disabled];
    const nextEnabled = [...enabled];
    if (def.defaultEnabled) {
      if (nextDisabled.includes(def.key)) {
        nextDisabled.splice(nextDisabled.indexOf(def.key), 1);
      } else {
        nextDisabled.push(def.key);
      }
    } else if (nextEnabled.includes(def.key)) {
      nextEnabled.splice(nextEnabled.indexOf(def.key), 1);
    } else {
      nextEnabled.push(def.key);
    }
    patchLib({
      presetId: "custom",
      fieldConfig: fieldConfigRecord({
        disabled: nextDisabled,
        enabled: nextEnabled,
      }),
    });
  };

  /** 词表失焦提交：去空去重写 fieldConfig.options[key] */
  const commitVocab = (key: string) => {
    if (!lib) return;
    const items = [...new Set(splitList(vocabs[key] ?? ""))];
    patchLib({
      presetId: "custom",
      fieldConfig: fieldConfigRecord({
        options: { ...(fc.options ?? {}), [key]: items },
      }),
    });
    setVocabs((prev) => ({ ...prev, [key]: items.join("，") }));
  };

  const removeCustom = (key: string) => {
    patchLib({
      presetId: "custom",
      fieldConfig: fieldConfigRecord({
        custom: customs.filter((c) => c.key !== key),
      }),
    });
  };

  const addCustom = () => {
    const key = customDraft.key.trim();
    if (!key) {
      setCustomError("key 不能为空");
      return;
    }
    if (BUILTIN_FIELDS.some((f) => f.key === key)) {
      setCustomError("key 与内置字段冲突");
      return;
    }
    if (customs.some((c) => c.key === key)) {
      setCustomError("key 重复");
      return;
    }
    const opts = splitList(customDraft.options);
    const entry: CustomFieldDef = {
      key,
      label: customDraft.label.trim() || key,
      type: customDraft.type,
      hint: customDraft.hint.trim(),
      ...(customDraft.type === "enum" && opts.length > 0
        ? { options: opts }
        : {}),
    };
    patchLib({
      presetId: "custom",
      fieldConfig: fieldConfigRecord({ custom: [...customs, entry] }),
    });
    setCustomDraft({ key: "", label: "", type: "string", hint: "", options: "" });
    setCustomError("");
  };

  const applyPreset = (id: string) => {
    const preset = getPreset(id);
    if (!preset || !lib) return;
    const nextFc = { ...preset.fieldConfig } as Record<string, unknown>;
    patchLib({ presetId: preset.id, fieldConfig: nextFc });
    setVocabs(
      initialVocabs({ ...lib, presetId: preset.id, fieldConfig: nextFc }),
    );
  };

  /**
   * 配置变更 banner 的「全库重跑」（M3.5.2.2 §4.6/§4.7）：
   * 确认走应用内对话框（ui/confirm，非浏览器消息）；启动成功（running 置位）
   * 后 configDirty 置 false；被守卫拦则保留 banner；运行中不重复启动（launchVision 守卫兜底）。
   */
  const handleRerunAll = async () => {
    if (useLibraryStore.getState().vision.running) return;
    const count = useLibraryStore.getState().items.length;
    const ok = await confirmDialog({
      title: "全库重跑识图",
      message: `将对 ${count} 张图重新识图，已成功条目也会重跑并产生费用，确定继续？`,
      confirmText: "确定重跑",
    });
    if (!ok) return;
    void rerunVisionAll();
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const st = useLibraryStore.getState();
      if (st.vision.blockedReason) return; // 被拦：banner 保留
      if (st.vision.running) {
        setConfigDirty(false);
        return;
      }
    }
    setConfigDirty(false);
  };

  /**
   * 提示窗定位与面板平移量（px）：面板与提示窗并排，两侧各留 edge(20px) 边距。
   * 一律用「距视口右缘偏移」表达（与 rect.right、面板 right 同坐标系）。
   * - 面板平移量 = rect.right − edge，使其右缘正好距视口右缘 20px；
   * - 提示窗左缘固定 edge，右缘贴面板平移后的左缘 − gap，宽度 = 两者之间；
   * - 宽度再按 maxWidth(600px，比默认 460 明显更宽、又不至于铺满整屏) 夹紧，
   *   窄视口放不下时按实际空间收窄（提示窗自身 overflow-y: auto 仍可用）。
   */
  const promptLayout = (() => {
    if (!promptMounted || !rect || panelWidth === 0) return null;
    const gap = 12;
    const edge = 20; // 与浏览器左右边缘保持的间距
    const maxWidth = 600; // 提示窗宽度上限（不铺满整屏）
    if (promptClosing) {
      // 收起中：平移量立刻归零（与提示窗淡出同时进行），但仍算出提示窗该占的宽高位置
      const base = Math.min(maxWidth, Math.max(0, window.innerWidth - edge - (rect.right - edge + panelWidth + gap)));
      return { width: base, shift: 0, right: rect.right - edge + panelWidth + gap };
    }
    const shift = Math.max(0, rect.right - edge); // 面板右缘 → 距视口右缘 edge
    const right = rect.right - shift + panelWidth + gap; // 提示窗右缘 = 面板左缘 − gap
    let width = window.innerWidth - edge - right;
    if (width > maxWidth) {
      // 宽度受限：提示窗靠左边距，与面板之间自然留白
      width = maxWidth;
    } else if (width < 200) {
      // 空间极窄：保底 200px，gap 撑大，两窗仍都不出屏幕
      width = Math.min(200, Math.max(80, window.innerWidth - edge - gap));
      return { width, shift, right: edge + width + gap };
    }
    return { width, shift, right };
  })();
  const shift = promptLayout ? promptLayout.shift : 0;

  return (
    <div
      className={"lib-settings__layer" + (leaving ? " is-leaving" : "")}
      onClick={(e) => {
        // 防御（M3.5.2.1 §4.6）：只有点中浮层本体才关闭，子元素事件不误关面板
        if (e.target === e.currentTarget) setSettingsOpen(false);
      }}
    >
      {promptMounted && promptLayout && rect && lib && (
        <PromptPanel
          top={rect.top}
          right={promptLayout.right}
          width={promptLayout.width}
          maxHeight={rect.maxHeight}
          entered={promptEntered}
          lib={lib}
          patchLib={patchLib}
        />
      )}
      <div
        ref={panelRef}
        className={"lib-settings" + (shift ? " is-shifted" : "")}
        style={{
          top: rect.top,
          right: rect.right,
          maxHeight: rect.maxHeight,
          "--prompt-shift": `${shift}px`,
        } as CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <section className="lib-settings__section">
          <header className="lib-settings__section-head">
            <span className="lib-settings__section-title">当前图库</span>
          </header>
          {!lib && <p className="lib-settings__hint">载入中…</p>}
          {lib && (
            <>
              {configDirty && (
                <div className="lib-settings__config-banner">
                  <span>识图配置已变更，对存量图片生效需全库重跑</span>
                  <button
                    type="button"
                    className="lib-settings__banner-btn"
                    onClick={() => void handleRerunAll()}
                  >
                    全库重跑
                  </button>
                  <button
                    type="button"
                    className="lib-settings__mini-btn"
                    onClick={() => setConfigDirty(false)}
                  >
                    知道了
                  </button>
                </div>
              )}
              <SettingsRow label="压缩档位">
                <div
                  className="lib-filter__seg"
                  role="group"
                  aria-label="图片压缩档位"
                >
                  <button
                    type="button"
                    className={lib.compression === "auto" ? "is-active" : ""}
                    aria-pressed={lib.compression === "auto"}
                    onClick={() => patchLib({ compression: "auto" })}
                  >
                    自动 1024
                  </button>
                  <button
                    type="button"
                    className={lib.compression === "high" ? "is-active" : ""}
                    aria-pressed={lib.compression === "high"}
                    onClick={() => patchLib({ compression: "high" })}
                  >
                    高 1536
                  </button>
                  <button
                    type="button"
                    className={lib.compression === "original" ? "is-active" : ""}
                    aria-pressed={lib.compression === "original"}
                    onClick={() => patchLib({ compression: "original" })}
                  >
                    原图
                  </button>
                </div>
              </SettingsRow>
              <SettingsRow label="分析预设">
                <select
                  className="lib-settings__select"
                  value={lib.presetId}
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  {VISION_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {lib.presetId === "custom" && (
                    <option value="custom" disabled>
                      自定义
                    </option>
                  )}
                </select>
                <button
                  type="button"
                  className="lib-settings__mini-btn"
                  title="查看与自定义识图提示词（开头/结尾两段）"
                  onClick={() => setPromptOpen((v) => !v)}
                >
                  {promptOpen ? "收起提示词" : "提示词"}
                </button>
              </SettingsRow>

              <div className="lib-settings__block">
                <span className="lib-settings__label">字段配置</span>
                <div className="lib-settings__checks">
                  {BUILTIN_FIELDS.map((def) => (
                    <label key={def.key} className="lib-settings__check">
                      <input
                        type="checkbox"
                        checked={isFieldOn(def)}
                        onChange={() => toggleField(def)}
                      />
                      <span>{FIELD_LABELS[def.key] ?? def.key}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="lib-settings__block">
                <span className="lib-settings__label">词表编辑</span>
                <div className="lib-settings__vocabs">
                  {VOCAB_FIELDS.map((key) => (
                    <label key={key} className="lib-settings__vocab-row">
                      <span className="lib-settings__hint">
                        {FIELD_LABELS[key]}词表（逗号/顿号/斜杠/换行分隔）
                      </span>
                      <textarea
                        className="lib-settings__vocab"
                        rows={2}
                        value={vocabs[key] ?? ""}
                        onChange={(e) =>
                          setVocabs((prev) => ({
                            ...prev,
                            [key]: e.target.value,
                          }))
                        }
                        onBlur={() => commitVocab(key)}
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="lib-settings__block">
                <span className="lib-settings__label">自定义字段</span>
                <div className="lib-settings__custom">
                  {customs.length > 0 && (
                    <div className="lib-settings__custom-list">
                      {customs.map((c) => (
                        <div key={c.key} className="lib-settings__custom-row">
                          <span>
                            {c.label}（{c.key} · {c.type}）
                          </span>
                          <button
                            type="button"
                            className="lib-settings__mini-btn"
                            onClick={() => removeCustom(c.key)}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="lib-settings__custom-form">
                    <input
                      className="lib-settings__input"
                      placeholder="key"
                      value={customDraft.key}
                      onChange={(e) =>
                        setCustomDraft({ ...customDraft, key: e.target.value })
                      }
                    />
                    <input
                      className="lib-settings__input"
                      placeholder="label"
                      value={customDraft.label}
                      onChange={(e) =>
                        setCustomDraft({ ...customDraft, label: e.target.value })
                      }
                    />
                    <select
                      className="lib-settings__select"
                      value={customDraft.type}
                      onChange={(e) =>
                        setCustomDraft({
                          ...customDraft,
                          type: e.target.value as CustomFieldDef["type"],
                        })
                      }
                    >
                      <option value="string">string</option>
                      <option value="string[]">string[]</option>
                      <option value="enum">enum</option>
                    </select>
                    <input
                      className="lib-settings__input"
                      placeholder="hint"
                      value={customDraft.hint}
                      onChange={(e) =>
                        setCustomDraft({ ...customDraft, hint: e.target.value })
                      }
                    />
                    {customDraft.type === "enum" && (
                      <input
                        className="lib-settings__input"
                        placeholder="options（逗号/顿号/斜杠分隔）"
                        value={customDraft.options}
                        onChange={(e) =>
                          setCustomDraft({
                            ...customDraft,
                            options: e.target.value,
                          })
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="lib-settings__mini-btn"
                      onClick={addCustom}
                    >
                      添加
                    </button>
                  </div>
                  {customError && (
                    <p className="lib-settings__error">{customError}</p>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
