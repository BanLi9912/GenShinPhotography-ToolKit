/**
 * 设置中心 → 通用 · 模块组件（2026-09-16 用户需求）：
 *
 * 一处看清「跑起来需要什么、可选模型装没装」，并让两条可选安装线可以真的点。
 *
 *   - 状态来自 dev server 中间件 `GET /api/components`（Node 侧读盘 + 读 process.version）；
 *   - 浏览器侧自测（Chromium / WebGPU / Ollama）始终本地做，所以 `vite preview` 或生产
 *     静态站点下中间件 404 时，面板降级为「仅浏览器侧检查」，中间件组各行显示「未知」；
 *   - **必需组（Node / 依赖 / 2x 资产）只显示状态，不提供安装动作**——那是
 *     `scripts/install.bat` 的职责，按钮 disabled 预留；
 *   - 可选组两条线是真按钮：POST `/api/components/install` `{ target }`。
 *
 * 许可口径：两条线都只从权利人官方渠道下载（Kim2091 的 HuggingFace / bilibili 的
 * ModelScope），我们不分发任何权重字节；Kim2091 系 CC BY-NC-SA 4.0（非商用）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { confirmDialog } from "../../ui/confirm";
import { toast } from "../../ui/toast";

/** 中间件 GET /api/components 的响应（字段与 vite.config.ts 的 ComponentsReport 对齐） */
interface ComponentsReport {
  node: { ok: boolean; version: string; path: string; required: string };
  deps: { ok: boolean; missing: string[] };
  superres2x: { ok: boolean; missing: string[] };
  superresPro: { ok: boolean; installed: string[]; missing: string[] };
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

/** 浏览器侧自测结果（不依赖 dev server） */
interface BrowserChecks {
  chromium: boolean;
  webgpu: boolean;
  ollama: boolean | null; // null = 还在探测
}

const FETCH_TIMEOUT_MS = 3000;
const OLLAMA_TIMEOUT_MS = 2000;
const OLLAMA_ENDPOINT = "http://localhost:11434"; // 与 vision/settings.ts 的默认端点一致

/** 三态徽章：ok = 绿 / bad = 红 / unknown = 灰（只用 token，零硬编码色值） */
type BadgeTone = "ok" | "bad" | "unknown";

function Badge({ tone, text }: { tone: BadgeTone; text: string }) {
  return <span className={`sc-cmp__badge is-${tone}`}>{text}</span>;
}

/** 一行组件：徽章 + 名称 + 说明 + 可选动作 */
function Row({
  name,
  tone,
  text,
  detail,
  action,
}: {
  name: string;
  tone: BadgeTone;
  text: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <li className="sc-cmp__row">
      <div className="sc-cmp__main">
        <span className="sc-cmp__name">{name}</span>
        <Badge tone={tone} text={text} />
        {detail && <span className="sc-cmp__detail">{detail}</span>}
      </div>
      {action && <div className="sc-cmp__ops">{action}</div>}
    </li>
  );
}

export function ComponentsPanel() {
  const [report, setReport] = useState<ComponentsReport | null>(null);
  /** 中间件是否可达（false = 降级为仅浏览器侧检查） */
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingMsg, setCheckingMsg] = useState("");
  const [browser, setBrowser] = useState<BrowserChecks>({
    chromium: false,
    webgpu: false,
    ollama: null,
  });
  /** 正在跑的安装目标（区分为按钮态） */
  const [installing, setInstalling] = useState<"texture" | "cugan" | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** 浏览器侧自测：Chromium 判定 / WebGPU 能力 / Ollama 连通 */
  const runBrowserChecks = useCallback(async () => {
    const ua = navigator.userAgent;
    const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
    const webgpu = typeof navigator !== "undefined" && "gpu" in navigator;
    if (alive.current) setBrowser((b) => ({ ...b, chromium, webgpu }));
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
      const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: controller.signal });
      window.clearTimeout(timer);
      if (alive.current) setBrowser((b) => ({ ...b, ollama: res.ok }));
    } catch {
      if (alive.current) setBrowser((b) => ({ ...b, ollama: false }));
    }
  }, []);

  /** 中间件状态查询（3s 超时；失败即降级） */
  const fetchReport = useCallback(async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch("/api/components", { signal: controller.signal });
      window.clearTimeout(timer);
      // vite preview / 静态站点会被 SPA 回退成 index.html（200 + text/html），
      // 单看 res.ok 是分辨不出来的，必须同时看 content-type。
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.includes("application/json")) throw new Error("no middleware");
      const data = (await res.json()) as ComponentsReport;
      if (!alive.current) return;
      setReport(data);
      setServerUp(true);
    } catch {
      window.clearTimeout(timer);
      if (!alive.current) return;
      setReport(null);
      setServerUp(false);
    }
  }, []);

  const recheck = useCallback(
    async (withMessage: boolean) => {
      setChecking(true);
      if (withMessage) setCheckingMsg("重新检测中…");
      await Promise.all([fetchReport(), runBrowserChecks()]);
      if (!alive.current) return;
      setChecking(false);
      setCheckingMsg("");
    },
    [fetchReport, runBrowserChecks],
  );

  useEffect(() => {
    void recheck(false);
  }, [recheck]);

  /** 两条可选线的安装动作 */
  const install = (target: "texture" | "cugan") => {
    void confirmDialog({
      title: target === "texture" ? "安装纹理保全模型" : "安装 CUGAN 3x/4x 模型",
      message:
        target === "texture"
          ? "将安装纹理保全线的两个模型：1x-SuperScale（抗锯齿）+ AnimeSharpV4 2x（纹理锐化）\n\n· 体积：约 33MB + 8.5MB 原始权重（另需 Python 转换工具链，首次约 200MB）\n· 来源：模型作者 Kim2091 的官方渠道（HuggingFace 官方 safetensors + GitHub Release）\n· 流程：作者未提供可直接用的 ONNX，两个模型都在本地转换（convert.py 自带数值校验）\n· 许可：CC BY-NC-SA 4.0（非商用、仅本地使用，请勿再分发）\n· 安装**在后台运行**（不会弹窗口），完成后回到本面板点「重新检测」查看结果"
          : "将安装 Real-CUGAN 3x/4x 全部六档模型（含 Python 转换工具链）：\n\n· 体积：约 1GB+（torch CPU 轮子约 200MB + 权重约 60MB）\n· 耗时：10-30 分钟\n· 流程：装 Python（已装则跳过）→ 隔离 venv + torch → 从 bilibili 官方 ModelScope 渠道下载 6 个 .pth → 本地转换（自带数值校验）\n· 权重本地转换、本地使用，我们不分发任何权重文件\n· 安装**在后台运行**（不会弹窗口），可随时查看日志文件跟进；完成后回到本面板点「重新检测」查看结果",
      confirmText: "开始安装",
    }).then((ok) => {
      if (!ok) return;
      void (async () => {
        setInstalling(target);
        try {
          const res = await fetch("/api/components/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target }),
          });
          const data = (await res.json()) as {
            ok?: boolean;
            reason?: string;
            error?: string;
            message?: string;
            mode?: string;
            log?: string;
          };
          if (!res.ok || !data.ok) {
            toast(data.reason ?? data.error ?? "安装启动失败");
            return;
          }
          // 后台模式下把日志路径带出来（用户唯一的进度可见入口）
          if (data.mode === "script" && data.log) {
            toast(`安装已在后台启动，日志：${data.log}`);
          } else {
            toast(data.message ?? "已启动安装");
          }
        } catch {
          toast("安装请求失败：开发服务器未运行？");
        } finally {
          if (alive.current) setInstalling(null);
        }
      })();
    });
  };

  const tone = (ok: boolean | null): BadgeTone => (ok === null ? "unknown" : ok ? "ok" : "bad");

  /** 必需组四行的后端状态（serverUp=false 时全部「未知」） */
  const nodeOk = serverUp ? !!report?.node.ok : null;
  const depsOk = serverUp ? !!report?.deps.ok : null;
  const asset2xOk = serverUp ? !!report?.superres2x.ok : null;
  const textureOk = serverUp ? report?.textureMissing.length === 0 : null;
  const cuganOk = serverUp ? report?.cuganMissing.length === 0 : null;

  const disabledAction = (label: string, title = "后续版本提供") => (
    <button type="button" className="sc-cmp__btn" disabled title={title}>
      {label}
    </button>
  );

  return (
    <section className="sc-cmp">
      <div className="sc-cmp__head">
        <span className="sc-cmp__title">模块组件</span>
        <button
          type="button"
          className="sc-cmp__btn sc-cmp__btn--ghost"
          disabled={checking}
          onClick={() => void recheck(true)}
        >
          {checking ? checkingMsg || "检测中…" : "重新检测"}
        </button>
      </div>

      {serverUp === false && (
        <p className="sc-cmp__notice">
          组件检测需要开发服务器运行（npm run dev / start-web.bat）；当前环境仅显示浏览器侧检查。
        </p>
      )}

      {/* --- 必需组 --- */}
      <div className="sc-cmp__group-title">必需组件</div>
      <ul className="sc-cmp__list">
        <Row
          name="便携 Node 运行时"
          tone={tone(nodeOk)}
          text={nodeOk === null ? "未知" : nodeOk ? "已就绪" : "缺失/版本不符"}
          detail={
            report
              ? `${report.node.version}（需 ${report.node.required}）`
              : "需 Node ^20.19.0 || >=22.12.0"
          }
          action={disabledAction("安装")}
        />
        <Row
          name="npm 依赖"
          tone={tone(depsOk)}
          text={depsOk === null ? "未知" : depsOk ? "已就绪" : "缺失"}
          detail={
            report && !report.deps.ok && report.deps.missing.length > 0
              ? `缺：${report.deps.missing.join(" / ")}`
              : "web/node_modules（vite / onnxruntime-web / upscalejs）"
          }
          action={disabledAction("安装")}
        />
        <Row
          name="超分 2x 资产"
          tone={tone(asset2xOk)}
          text={asset2xOk === null ? "未知" : asset2xOk ? "已就绪" : "缺失"}
          detail={
            report && !report.superres2x.ok && report.superres2x.missing.length > 0
              ? `缺 ${report.superres2x.missing.length} 个文件（npm run predev 生成）`
              : "public/superres-assets（ORT 运行时 + 2x 四档，predev 生成）"
          }
          action={disabledAction("安装")}
        />
        <Row
          name="Chromium 浏览器"
          tone={tone(browser.chromium)}
          text={browser.chromium ? "已就绪" : "不满足"}
          detail="图库选文件夹用 FSA，需 Chromium 系（Chrome/Edge）+ localhost 或 https"
          action={disabledAction("安装", "浏览器请自行安装")}
        />
      </ul>

      {/* --- 可选组 --- */}
      <div className="sc-cmp__group-title">可选模型组件</div>
      <ul className="sc-cmp__list">
        <Row
          name="纹理保全线"
          tone={tone(textureOk)}
          text={textureOk === null ? "未知" : textureOk ? "已就绪" : "未安装"}
          detail={
            textureOk === null
              ? "1x-SuperScale + AnimeSharpV4 2x"
              : textureOk
                ? "1x-SuperScale + AnimeSharpV4 2x（约 34MB）"
                : "1x-SuperScale + AnimeSharpV4 2x（约 34MB，来自模型作者官方渠道，本地转换）"
          }
          action={
            textureOk ? (
              <button type="button" className="sc-cmp__btn" disabled title="已安装">
                已安装
              </button>
            ) : (
              <button
                type="button"
                className="sc-cmp__btn"
                disabled={!serverUp || installing === "texture"}
                onClick={() => install("texture")}
                title={
                  !serverUp
                    ? "需要开发服务器"
                    : "会运行 scripts\\install.bat /texture（作者未提供可用 ONNX，改走官方 safetensors 本地转换）"
                }
              >
                {installing === "texture" ? "启动中…" : "安装"}
              </button>
            )
          }
        />
        <Row
          name="CUGAN 3x/4x 线"
          tone={tone(cuganOk)}
          text={cuganOk === null ? "未知" : cuganOk ? "已就绪" : "未安装"}
          detail={
            cuganOk === null
              ? "Real-CUGAN 3x/4x 六档（约 1GB+，含 Python 工具链）"
              : cuganOk
                ? "Real-CUGAN 3x/4x 六档（no-denoise / denoise3x / conservative）"
                : "Real-CUGAN 3x/4x 六档（约 1GB+，含 Python 工具链，10-30 分钟）"
          }
          action={
            cuganOk ? (
              <button type="button" className="sc-cmp__btn" disabled title="已安装">
                已安装
              </button>
            ) : (
              <button
                type="button"
                className="sc-cmp__btn"
                disabled={!serverUp || installing === "cugan"}
                onClick={() => install("cugan")}
                title={!serverUp ? "需要开发服务器" : "运行 scripts\\install.bat /cugan"}
              >
                {installing === "cugan" ? "启动中…" : "安装"}
              </button>
            )
          }
        />
        <Row
          name="Ollama 向量引擎"
          tone={browser.ollama === null ? "unknown" : browser.ollama ? "ok" : "unknown"}
          text={
            browser.ollama === null ? "检测中…" : browser.ollama ? "已就绪" : "未运行"
          }
          detail={
            browser.ollama
              ? `${OLLAMA_ENDPOINT}（向量搜索可用）`
              : "未运行不影响使用：向量搜索会自动回落词典引擎（本面板不代装）"
          }
        />
        <Row
          name="WebGPU 加速"
          tone={browser.webgpu ? "ok" : "bad"}
          text={browser.webgpu ? "可用" : "不可用"}
          detail={
            browser.webgpu
              ? "超分优先走 GPU，失败自动回落 WASM"
              : "浏览器不支持 WebGPU，超分走 WASM（CPU）"
          }
        />
      </ul>

      {report && (
        <p className="sc-cmp__paths" title={`${report.srModelsDir} / ${report.assetsDir}`}>
          产物目录：{report.srModelsDir}
        </p>
      )}
    </section>
  );
}
