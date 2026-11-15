/**
 * 添加/编辑自定义供应商弹窗（2026-09-26 任务卡）：
 * 名称 / API 地址两字段（**不含 key 与模型**——均复用主界面现有行：
 * key 行与模型行绑定当前选中供应商自己的值，用户口径「输入组件复用」）；
 * 保存校验（名称与地址非空 + https）→ 写 VisionGlobalSettings.customProviders
 * （含 setCustomProviders 同步）→ add 模式保存后自动切换到新供应商。
 * 样式对齐设置面板浮层（.lib-settings 体系 + ystk-confirm 的玻璃面板惯例），
 * Esc 关闭、点遮罩关闭。
 *
 * 浮层挂 body（portal）：设置中心是 fixed + backdrop-filter 的覆盖层（SettingsCenter.css），
 * 其内渲染会困在 #root 层叠上下文里且被裁切（同 confirm.tsx / DetailView 惯例）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { newCustomProviderId } from "../vision/providers";
import {
  loadVisionGlobal,
  type CustomProviderConfig,
} from "../vision/settings";

/** 保存回调载荷：新表 + add 模式下要自动切换到的供应商 id */
export type ProviderSaveResult = {
  customProviders: CustomProviderConfig[];
  selectId?: string;
};

/** 地址必须 https（与 dev 中间件 /api/vision 的校验口径一致，非 https 直接拦在弹窗） */
const HTTPS_BASE_URL_RE = /^https:\/\//;

export function AddProviderDialog({
  mode,
  provider,
  onSave,
  onClose,
}: {
  mode: "add" | "edit";
  /** edit 模式带现值（apiKey/model 不进草稿、不渲染输入，编辑不改它们） */
  provider?: CustomProviderConfig;
  /** 保存：由父组件走 patchGlobal 落盘（设置面板持有面板 state，避免两处写设置） */
  onSave: (result: ProviderSaveResult) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);

  /**
   * 打开即聚焦名称输入，**只在挂载时执行一次**（依赖数组必须为空）：
   * 聚焦不依赖 onClose —— 父组件传入的是内联箭头（GlobalSettingsPanel 的
   * `onClose={() => setProviderDialog(null)}`），父组件每次重渲染都换引用，
   * 若把 onClose 放进依赖数组，弹窗打开期间会在每次父重渲染时重跑本 effect
   * 把焦点反复抢回名称框（2026-10-03 用户报 bug：队列运行时 1s 成本轮询
   * 重渲染 → 光标每秒被抢回一次，导致无法在 API 地址框连续输入）。
   */
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Esc 关闭（点遮罩关闭见 mask 的 onMouseDown）；依赖仍为 [onClose]：
  // 重订阅无害，且必须拿到最新闭包
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = () => {
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!trimmedName) {
      setError("请填写供应商名称");
      return;
    }
    if (!HTTPS_BASE_URL_RE.test(trimmedUrl)) {
      setError("API 地址必须以 https:// 开头（如 https://api.siliconflow.cn/v1）");
      return;
    }
    setError("");
    void (async () => {
      // 表以 idb 现值重建：设置面板的 g 可能是旧快照，避免覆盖别处的增删
      const current = await loadVisionGlobal();
      if (mode === "edit" && provider) {
        // edit：原 id 原位替换，apiKey / model 现值保留不动（那是主界面两行的地盘）
        onSave({
          customProviders: current.customProviders.map((p) =>
            p.id === provider.id
              ? { ...p, name: trimmedName, baseUrl: trimmedUrl }
              : p,
          ),
        });
      } else {
        // add：新 id，apiKey 与 model 以 "" 起步（主界面 key 行 / 模型行填）；
        // 价格三字段显式置 0（价格行按供应商绑定），保存后内存态立即有效，
        // 不必等下次 loadVisionGlobal 的归一
        const created: CustomProviderConfig = {
          id: newCustomProviderId(),
          name: trimmedName,
          baseUrl: trimmedUrl,
          apiKey: "",
          model: "",
          priceInput: 0,
          priceCached: 0,
          priceOutput: 0,
        };
        onSave({
          customProviders: [...current.customProviders, created],
          selectId: created.id,
        });
      }
      onClose();
    })();
  };

  return createPortal(
    <div
      className="ystk-confirm"
      role="dialog"
      aria-modal="true"
      aria-label={mode === "add" ? "添加供应商" : "编辑供应商"}
    >
      <div className="ystk-confirm__mask" onMouseDown={() => onClose()} />
      <div className="ystk-confirm__panel lib-settings__dialog">
        <h3 className="ystk-confirm__title">
          {mode === "add" ? "添加供应商" : "编辑供应商"}
        </h3>
        <label className="lib-settings__dialog-field">
          <span className="lib-settings__label">名称</span>
          <input
            ref={nameRef}
            className="lib-settings__input lib-settings__input--key"
            value={name}
            placeholder="如 硅基流动"
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
          />
        </label>
        <label className="lib-settings__dialog-field">
          <span className="lib-settings__label">API 地址</span>
          <input
            className="lib-settings__input lib-settings__input--key"
            value={baseUrl}
            placeholder="https://api.siliconflow.cn/v1"
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setError("");
            }}
          />
        </label>
        <p className="lib-settings__hint">
          仅支持 OpenAI 兼容（chat/completions）厂商；请求经本机 dev server
          转发，规避浏览器跨域。API key 与模型在设置面板对应行里填。
        </p>
        {error && <p className="lib-settings__error">{error}</p>}
        <div className="lib-settings__dialog-btns">
          <button
            type="button"
            className="ystk-confirm__btn"
            onClick={() => onClose()}
          >
            取消
          </button>
          <button
            type="button"
            className="ystk-confirm__btn ystk-confirm__btn--primary"
            onClick={() => save()}
          >
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
