/**
 * M3 全局（跨图库）识图设置区块（自 SettingsPanel 迁出，任务 2026-09-08）：
 * 搜索引擎 / Ollama / 识图总开关 / 新增图片自动识图 / Provider / API key / 区域 /
 * 模型 / 并发 / 价格 / 本轮预算 / 累计成本与清零。即改即存（idb，无保存按钮）。
 *
 * 本组件为普通流式区块（无浮层锚定），供应用壳设置中心 M3 分区渲染；
 * 自顶栏齿轮进入的是全局中心，无当前图库语境，故原「立即开始识图 / 中止识图」
 * 按钮不迁入——识图启动与中止统一经识图小窗（VisionWidget）与库内各入口完成。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { listItems } from "../index/indexFile";
import { useLibraryStore } from "../store";
import { confirmDialog } from "../../../ui/confirm";
import { AddProviderDialog } from "./AddProviderDialog";
import type { ProviderSaveResult } from "./AddProviderDialog";
import { getProvider } from "../vision/providers";
import {
  loadVisionCostTotal,
  loadVisionGlobal,
  resetVisionCostTotal,
  saveVisionGlobal,
  type CustomProviderConfig,
  type VisionCostTotal,
  type VisionGlobalSettings,
} from "../vision/settings";
import * as vectorStore from "../search/vector/store";

function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lib-settings__row">
      <span className="lib-settings__label">{label}</span>
      {children}
    </div>
  );
}

/** 供应商弹窗打开态（null = 关闭） */
type ProviderDialogState =
  | { mode: "add" }
  | { mode: "edit"; provider: CustomProviderConfig };

/** Provider 下拉的内置项（fake 不渲染：仅 devhooks 自验点名用） */
const MINIMAX_PROVIDER_OPTION: ProviderOption = {
  id: "minimax",
  name: "MiniMax",
};

/** Provider 下拉条目：自定义项带 custom 即渲染行内「编辑 / 删除」 */
type ProviderOption = {
  id: string;
  name: string;
  custom?: CustomProviderConfig;
};

/**
 * Provider 下拉菜单内容（自绘，2026-09-26 用户口径：编辑/删除**放进下拉菜单里**）：
 * 原生 select 嵌不了按钮，故全部条目自绘——内置项只有名字，自定义项右侧带「编辑 / 删除」。
 * 浮层本体（portal + fixed）在调用处，本组件只管条目结构。
 */
function ProviderMenuItems({
  currentId,
  customProviders,
  onPick,
  onEdit,
  onDelete,
  onAdd,
}: {
  currentId: string;
  customProviders: CustomProviderConfig[];
  onPick: (id: string) => void;
  onEdit: (provider: CustomProviderConfig) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
}) {
  const options: ProviderOption[] = [
    MINIMAX_PROVIDER_OPTION,
    ...customProviders.map((p) => ({ id: p.id, name: p.name, custom: p })),
  ];
  return (
    <>
      {options.map((opt) => (
        <div
          key={opt.id}
          className={
            "lib-settings__provider-opt" + (opt.id === currentId ? " is-active" : "")
          }
        >
          <button
            type="button"
            role="option"
            aria-selected={opt.id === currentId}
            className="lib-settings__provider-opt-name"
            onClick={() => onPick(opt.id)}
          >
            {opt.name}
          </button>
          {opt.custom && (
            <button
              type="button"
              className="lib-settings__provider-opt-op"
              title={`编辑「${opt.name}」`}
              onClick={() => onEdit(opt.custom!)}
            >
              编辑
            </button>
          )}
          {opt.custom && (
            <button
              type="button"
              className="lib-settings__provider-opt-op"
              title={`删除「${opt.name}」`}
              onClick={() => onDelete(opt.id)}
            >
              删除
            </button>
          )}
        </div>
      ))}
      <div className="lib-settings__provider-sep" aria-hidden="true" />
      <button type="button" className="lib-settings__provider-add" onClick={onAdd}>
        添加供应商…
      </button>
    </>
  );
}

export function LibraryGlobalSettingsPanel() {
  const visionRunning = useLibraryStore((s) => s.vision.running);
  const libraries = useLibraryStore((s) => s.libraries);
  const crossLibrary = useLibraryStore((s) => s.crossLibrary);
  const setCrossLibrary = useLibraryStore((s) => s.setCrossLibrary);
  const [g, setG] = useState<VisionGlobalSettings | null>(null);
  const [cost, setCost] = useState<VisionCostTotal | null>(null);
  const [showKey, setShowKey] = useState(false);
  /** 添加/编辑自定义供应商弹窗（2026-09-26：provider 下拉的「添加供应商…」入口） */
  const [providerDialog, setProviderDialog] = useState<ProviderDialogState | null>(
    null,
  );
  /**
   * Provider 自绘下拉（2026-09-26 用户口径：编辑/删除**放进下拉菜单里**）。
   * 原生 select 不能嵌按钮 → 触发钮 + 玻璃浮层菜单；菜单 **portal 挂 body + fixed**：
   * 设置中心带 backdrop-filter，其内渲染会因 Backdrop Root 限制导致磨砂失效（design.md §7.13）。
   */
  const [providerOpen, setProviderOpen] = useState(false);
  const providerMenuPos = useRef<{ top: number; left: number; width: number } | null>(
    null,
  );
  const providerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const providerMenuRef = useRef<HTMLDivElement | null>(null);
  /** M3.4.5 向量引擎指示灯：订阅向量 store（engine/ollama/索引计数变化即重渲染） */
  const vs = useSyncExternalStore(
    vectorStore.subscribeVectorStatus,
    vectorStore.getVectorStatus,
  );
  /** 地址/模型文本框 600ms 防抖 timer */
  const ollamaFieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 挂载即载入全局设置 + 累计成本
  useEffect(() => {
    void (async () => {
      const gs = await loadVisionGlobal();
      const ct = await loadVisionCostTotal();
      setG(gs);
      setCost(ct);
    })();
  }, []);

  // 队列运行期间轮询累计成本（1s 一次）；结束时再刷新一次
  useEffect(() => {
    if (!visionRunning) return;
    const timer = setInterval(() => {
      void loadVisionCostTotal().then(setCost);
    }, 1000);
    return () => clearInterval(timer);
  }, [visionRunning]);

  /**
   * Provider 菜单定位：与触发钮**同宽同左沿**（用户 2026-09-26 口径：宽度对齐下拉钮）
   * —— 钮拉满一行时菜单即与内容列等宽，既匹配尺寸又天然不越出面板；再夹一道视口护栏。
   * **在点击处理里同步求值**（不能只靠 layout effect）：首次打开时菜单渲染依赖
   * `providerMenuPos.current`，而写 ref 不触发重渲染——首帧若为 null 菜单就不出现，
   * 表现为「首次点无响应」（2026-09-26 用户反馈的 bug）。
   */
  const placeProviderMenu = () => {
    const r = providerTriggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(120, Math.min(r.width, window.innerWidth - r.left - 8));
    providerMenuPos.current = { top: r.bottom + 4, left: r.left, width };
  };

  const toggleProviderMenu = () => {
    if (providerOpen) {
      setProviderOpen(false);
      return;
    }
    placeProviderMenu();
    setProviderOpen(true);
  };

  // 已打开期间的兜底校正（布局异步落定 / 尺寸变化）；定位主体在 toggleProviderMenu
  useLayoutEffect(() => {
    if (!providerOpen) return;
    const r = providerTriggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(120, Math.min(r.width, window.innerWidth - r.left - 8));
    providerMenuPos.current = { top: r.bottom + 4, left: r.left, width };
  }, [providerOpen]);

  /**
   * 点菜单外 / 按 Esc / **滚动**关闭。
   * 滚动必须关（2026-09-26 用户反馈「滚动滚轮菜单不收回」）：菜单是 fixed 定位，
   * 滚动面板会让它漂在错位的锚点上；capture 监听可捕获任意滚动容器
   * （设置面板右列 .sc-content 自身滚动，scroll 事件不冒泡到 window）。
   *
   * Esc 用 **capture 阶段 + stopImmediatePropagation**（2026-09-26 用户口径「改监听优先级」）：
   * 设置中心自身的 Esc 关闭挂在 window 冒泡阶段（SettingsCenter.tsx:183-190），
   * 若本菜单也用冒泡，一次 Esc 会先关菜单、事件继续冒泡再关掉整个设置中心。
   * 在捕获阶段拦下并阻止其继续传播 → 菜单开着时 Esc 只关菜单。
   */
  useEffect(() => {
    if (!providerOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (providerTriggerRef.current?.contains(target)) return;
      if (providerMenuRef.current?.contains(target)) return;
      setProviderOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setProviderOpen(false);
    };
    const onScroll = () => setProviderOpen(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [providerOpen]);

  const prevRunning = useRef(visionRunning);
  useEffect(() => {
    if (prevRunning.current && !visionRunning) {
      void loadVisionCostTotal().then(setCost);
    }
    prevRunning.current = visionRunning;
  }, [visionRunning]);

  const patchGlobal = (patch: Partial<VisionGlobalSettings>) => {
    setG((prev) => (prev ? { ...prev, ...patch } : prev));
    void saveVisionGlobal(patch);
  };

  /**
   * 搜索引擎 / Ollama 设置变更：先落盘 → 刷新向量 store 状态，
   * 引擎=向量 且 Ollama 在线时触发一轮 sync。
   */
  const patchVectorConfig = (patch: Partial<VisionGlobalSettings>) => {
    setG((prev) => (prev ? { ...prev, ...patch } : prev));
    void (async () => {
      await saveVisionGlobal(patch);
      await vectorStore.refreshSettings();
      const st = vectorStore.getVectorStatus();
      if (st.engine !== "vector") return;
      await vectorStore.selfCheckOllama();
      if (vectorStore.getVectorStatus().ollamaOk) {
        await vectorStore.syncEmbeddings(listItems());
      }
    })();
  };

  /** 地址/模型文本框逐键触发太重：本地 600ms 防抖合并后再落盘 + sync */
  const patchVectorFieldDebounced = (patch: Partial<VisionGlobalSettings>) => {
    setG((prev) => (prev ? { ...prev, ...patch } : prev));
    if (ollamaFieldTimer.current) clearTimeout(ollamaFieldTimer.current);
    ollamaFieldTimer.current = setTimeout(() => {
      ollamaFieldTimer.current = null;
      patchVectorConfig(patch);
    }, 600);
  };

  /** 引擎状态指示灯 */
  const engineDot = vs.syncing
    ? "var(--accent)"
    : vs.ollamaOk
      ? "var(--success)"
      : "var(--danger)";
  const engineText = vs.syncing
    ? "索引中…"
    : vs.ollamaOk
      ? `已连接 · 索引 ${vs.embedded}/${vs.total}`
      : "未连接";

  const setPrice = (
    key: "priceInput" | "priceCached" | "priceOutput",
    raw: string,
  ) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return;
    if (key === "priceInput") patchGlobal({ priceInput: v });
    else if (key === "priceCached") patchGlobal({ priceCached: v });
    else patchGlobal({ priceOutput: v });
  };

  /**
   * 当前选中供应商的自定义配置（undefined = 内置 MiniMax）。
   * key 行与模型行始终显示、组件复用，读写按当前供应商分流
   * （2026-09-26 用户三轮口径：存储一供应商一份、输入组件复用）。
   */
  const currentCustom = g?.customProviders.find((p) => p.id === g.providerId);
  const currentKey = currentCustom ? currentCustom.apiKey : (g?.apiKey ?? "");
  const currentModel = currentCustom ? currentCustom.model : (g?.model ?? "");
  /** 以 id 定位替换单个自定义供应商（key 行 / 模型行 / 编辑弹窗共用） */
  const patchCustom = (id: string, patch: Partial<CustomProviderConfig>) => {
    if (!g) return;
    patchGlobal({
      customProviders: g.customProviders.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
    });
  };
  const setCurrentKey = (value: string) => {
    if (currentCustom) patchCustom(currentCustom.id, { apiKey: value });
    else patchGlobal({ apiKey: value });
  };
  const setCurrentModel = (value: string) => {
    if (currentCustom) patchCustom(currentCustom.id, { model: value });
    else patchGlobal({ model: value });
  };

  /** 弹窗保存：写 customProviders（add 模式顺手切到新供应商） */
  const handleProviderSave = (result: ProviderSaveResult) => {
    patchGlobal({
      customProviders: result.customProviders,
      ...(result.selectId ? { providerId: result.selectId } : {}),
    });
  };

  /**
   * 删除自定义供应商：确认 → 从表移除（saveVisionGlobal 内同步 provider 表）；
   * 删的是当前选中项时 providerId 切回 minimax（残留 id 也有 getProvider 兜底）
   */
  const handleDeleteProvider = async (id: string) => {
    if (!g) return;
    const target = g.customProviders.find((p) => p.id === id);
    const ok = await confirmDialog({
      title: "删除供应商",
      message: `删除供应商「${target?.name ?? id}」？不影响其他设置。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    patchGlobal({
      customProviders: g.customProviders.filter((p) => p.id !== id),
      ...(g.providerId === id ? { providerId: "minimax" } : {}),
    });
  };

  return (
    <div>
      <div className="lib-settings__section-head">
        <span className="lib-settings__section-title">全局（跨图库）</span>
      </div>
      {/* PR-007：跨图库搜索开关（用户偏好，即改即存）——独立于识图设置载入态 */}
      <div className="lib-settings__block">
        <div className="lib-settings__row">
          <span className="lib-settings__label">跨图库搜索</span>
          <button
            type="button"
            role="switch"
            aria-checked={crossLibrary}
            className={"lib-filter__switch" + (crossLibrary ? " is-on" : "")}
            disabled={libraries.length < 2}
            onClick={() => setCrossLibrary(!crossLibrary)}
          >
            <span className="lib-filter__switch-knob" />
          </button>
        </div>
        <p className="lib-settings__hint">
          开启后，检索或筛选时同时搜索其它已绑定图库（只读，不切换当前库）。
          {libraries.length < 2 &&
            " 当前仅绑定 1 个图库，跨库搜索暂停；绑定第二个图库后自动恢复。"}
        </p>
      </div>
      {!g ? (
        <p className="lib-settings__hint">载入中…</p>
      ) : (
        <>
          <div className="lib-settings__block">
            <div className="lib-settings__row">
              <span className="lib-settings__label">搜索引擎</span>
              <div
                className="lib-settings__engine-ctrl"
                style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}
              >
                <div className="lib-filter__seg" role="group" aria-label="搜索引擎">
                  <button
                    type="button"
                    className={g.searchEngine === "dict" ? "is-active" : ""}
                    aria-pressed={g.searchEngine === "dict"}
                    onClick={() => patchVectorConfig({ searchEngine: "dict" })}
                  >
                    词典
                  </button>
                  <button
                    type="button"
                    className={g.searchEngine === "vector" ? "is-active" : ""}
                    aria-pressed={g.searchEngine === "vector"}
                    onClick={() => patchVectorConfig({ searchEngine: "vector" })}
                  >
                    向量
                  </button>
                </div>
                {g.searchEngine === "vector" && (
                  <span
                    className="lib-settings__engine-light"
                    title={!vs.ollamaOk ? (vs.error ?? "Ollama 未连接") : undefined}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      fontSize: "var(--text-xs)",
                      color: "var(--text-2)",
                    }}
                  >
                    <span
                      className="lib-settings__engine-dot"
                      aria-hidden="true"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: engineDot,
                        display: "inline-block",
                      }}
                    />
                    {engineText}
                  </span>
                )}
              </div>
            </div>
            {g.searchEngine === "vector" && (
              <>
                <SettingsRow label="Ollama 地址">
                  <input
                    className="lib-settings__input lib-settings__input--key"
                    value={g.ollamaEndpoint}
                    placeholder="http://localhost:11434"
                    onChange={(e) =>
                      patchVectorFieldDebounced({ ollamaEndpoint: e.target.value })
                    }
                  />
                </SettingsRow>
                <SettingsRow label="嵌入模型">
                  <input
                    className="lib-settings__input lib-settings__input--key"
                    value={g.ollamaModel}
                    placeholder="bge-m3"
                    onChange={(e) =>
                      patchVectorFieldDebounced({ ollamaModel: e.target.value })
                    }
                  />
                </SettingsRow>
              </>
            )}
          </div>
          <SettingsRow label="识图总开关">
            <button
              type="button"
              role="switch"
              aria-checked={g.enabled}
              className={"lib-filter__switch" + (g.enabled ? " is-on" : "")}
              onClick={() => patchGlobal({ enabled: !g.enabled })}
            >
              <span className="lib-filter__switch-knob" />
            </button>
          </SettingsRow>
          <SettingsRow label="新增图片自动识图">
            <div className="lib-settings__switch-col">
              <button
                type="button"
                role="switch"
                aria-checked={g.autoRecognizeNew}
                className={
                  "lib-filter__switch" + (g.autoRecognizeNew ? " is-on" : "")
                }
                onClick={() =>
                  patchGlobal({ autoRecognizeNew: !g.autoRecognizeNew })
                }
              >
                <span className="lib-filter__switch-knob" />
              </button>
              <span className="lib-settings__hint">
                关闭后，重扫发现的新图需在识图小窗手动确认
              </span>
            </div>
          </SettingsRow>
          <SettingsRow label="Provider">
            {/* 自绘下拉（原生 select 不能嵌按钮）：触发钮显示当前供应商，
                展开的菜单里每个自定义供应商条目右侧直接带「编辑 / 删除」 */}
            <button
              type="button"
              ref={providerTriggerRef}
              className="lib-settings__provider-trigger"
              aria-haspopup="listbox"
              aria-expanded={providerOpen}
              onClick={toggleProviderMenu}
            >
              <span className="lib-settings__provider-trigger-name">
                {getProvider(g.providerId).name}
              </span>
              <span className="lib-settings__caret" aria-hidden="true">
                ▾
              </span>
            </button>
          </SettingsRow>
          {g.customProviders.length === 0 && (
            <p className="lib-settings__hint">
              可添加任意 OpenAI 兼容（chat/completions）厂商：选「添加供应商…」填名称与
              API 地址，再在下方 API key / 模型行填该厂商的 key 与模型 id。
            </p>
          )}
          {/* Provider 下拉菜单（portal 挂 body + fixed：磨砂规避 design.md §7.13）：
              自定义供应商条目右侧直接给「编辑 / 删除」——用户 2026-09-26 口径 */}
          {providerOpen &&
            providerMenuPos.current &&
            createPortal(
              <div
                ref={providerMenuRef}
                className="lib-settings__provider-menu"
                style={{
                  top: providerMenuPos.current.top,
                  left: providerMenuPos.current.left,
                  width: providerMenuPos.current.width,
                }}
                role="listbox"
                aria-label="选择供应商"
              >
                <ProviderMenuItems
                  currentId={g.providerId}
                  customProviders={g.customProviders}
                  onPick={(id) => {
                    patchGlobal({ providerId: id });
                    setProviderOpen(false);
                  }}
                  onEdit={(provider) => {
                    setProviderOpen(false);
                    setProviderDialog({ mode: "edit", provider });
                  }}
                  onDelete={(id) => {
                    setProviderOpen(false);
                    void handleDeleteProvider(id);
                  }}
                  onAdd={() => {
                    setProviderOpen(false);
                    setProviderDialog({ mode: "add" });
                  }}
                />
              </div>,
              document.body,
            )}
          <SettingsRow label="API key">
            <div className="lib-settings__key-wrap">
              <input
                className="lib-settings__input lib-settings__input--key"
                type={showKey ? "text" : "password"}
                placeholder="明文存本地 IndexedDB"
                value={currentKey}
                onChange={(e) => setCurrentKey(e.target.value)}
              />
              <button
                type="button"
                className="lib-settings__eye"
                aria-label={showKey ? "隐藏 API key" : "显示 API key"}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
          </SettingsRow>
          {!currentCustom && (
            <SettingsRow label="区域">
              <div className="lib-filter__seg" role="group" aria-label="账号区域">
                <button
                  type="button"
                  className={g.region === "cn" ? "is-active" : ""}
                  aria-pressed={g.region === "cn"}
                  onClick={() => patchGlobal({ region: "cn" })}
                >
                  中国大陆 cn
                </button>
                <button
                  type="button"
                  className={g.region === "intl" ? "is-active" : ""}
                  aria-pressed={g.region === "intl"}
                  onClick={() => patchGlobal({ region: "intl" })}
                >
                  国际 intl
                </button>
              </div>
            </SettingsRow>
          )}
          <SettingsRow label="模型 ID">
            <input
              className="lib-settings__input lib-settings__input--key"
              value={currentModel}
              placeholder={
                currentCustom
                  ? "填厂商模型 id，如 Qwen/Qwen2.5-VL-72B-Instruct"
                  : undefined
              }
              onChange={(e) => setCurrentModel(e.target.value)}
            />
          </SettingsRow>
          {currentCustom && !currentModel.trim() && (
            <p className="lib-settings__error">
              {currentCustom.name} 还没填模型 id，识图会因上游 4xx 失败
            </p>
          )}
          <SettingsRow label="并发">
            <div className="lib-settings__concurrency">
              <input
                className="lib-settings__input lib-settings__input--num"
                type="number"
                min={1}
                max={5}
                value={g.concurrency}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v)) return;
                  patchGlobal({
                    concurrency: Math.max(1, Math.min(5, Math.round(v))),
                  });
                }}
              />
              <span className="lib-settings__hint">下一轮生效</span>
            </div>
          </SettingsRow>
          <SettingsRow label="价格（元/1M tokens）">
            <div className="lib-settings__prices">
              <label className="lib-settings__price">
                <span>输入</span>
                <input
                  className="lib-settings__input"
                  type="number"
                  step={0.01}
                  min={0}
                  value={g.priceInput}
                  onChange={(e) => setPrice("priceInput", e.target.value)}
                />
              </label>
              <label className="lib-settings__price">
                <span>缓存命中</span>
                <input
                  className="lib-settings__input"
                  type="number"
                  step={0.01}
                  min={0}
                  value={g.priceCached}
                  onChange={(e) => setPrice("priceCached", e.target.value)}
                />
              </label>
              <label className="lib-settings__price">
                <span>输出</span>
                <input
                  className="lib-settings__input"
                  type="number"
                  step={0.01}
                  min={0}
                  value={g.priceOutput}
                  onChange={(e) => setPrice("priceOutput", e.target.value)}
                />
              </label>
            </div>
          </SettingsRow>
          <SettingsRow label="本轮预算上限">
            <input
              className="lib-settings__input lib-settings__input--num"
              type="number"
              min={0}
              step={0.01}
              placeholder="0 = 不限"
              value={g.budgetLimit}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v) || v < 0) return;
                patchGlobal({ budgetLimit: v });
              }}
            />
          </SettingsRow>
          {cost && (
            <div className="lib-settings__cost-row">
              <span className="lib-settings__cost">
                累计 {cost.images} 张 · prompt {cost.promptTokens} / cached{" "}
                {cost.cachedTokens} / completion {cost.completionTokens} · ¥
                {cost.amount.toFixed(4)}
              </span>
              <button
                type="button"
                className="lib-settings__mini-btn"
                onClick={() => {
                  void confirmDialog({
                    title: "清零识图成本",
                    message: "确定清零累计识图成本？",
                    confirmText: "清零",
                    danger: true,
                  }).then((ok) => {
                    if (ok) {
                      void resetVisionCostTotal().then(() =>
                        loadVisionCostTotal().then(setCost),
                      );
                    }
                  });
                }}
              >
                清零
              </button>
            </div>
          )}
        </>
      )}
      {providerDialog && (
        <AddProviderDialog
          mode={providerDialog.mode}
          provider={
            providerDialog.mode === "edit" ? providerDialog.provider : undefined
          }
          onSave={handleProviderSave}
          onClose={() => setProviderDialog(null)}
        />
      )}
    </div>
  );
}
