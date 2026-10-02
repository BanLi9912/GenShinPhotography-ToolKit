/**
 * 本地服务（dev server / Node 中间件）在线状态探测（2026-10-02 用户需求）：
 * 顶栏「本地服务」指示灯要真正指示后台服务的启动情况。
 *
 * 语义（三态，与 vite.config.ts 的 `GET /api/health` 一一对应）：
 *   - `checking`：首次探测还没回来（避免首屏闪一下"未连接"）
 *   - `online`  ：探测到本地 Node 中间件 → 需要 Node 侧的能力都可用
 *                （「在文件夹中打开」「图库注册表」「识图供应商代理」「组件安装」）
 *   - `static`  ：拿到了 404 —— 说明服务在，但**是纯静态构建**（`vite preview`
 *                或任何静态托管）：页面本身可用，Node 侧能力不可用
 *   - `offline` ：请求连不上 —— dev server 没跑／启动中／中途挂了
 *
 * 为什么不用 `/api/components` 当心跳：那个端点要读盘、量体积、带 1.5s 微缓存，
 * 是「组件状态」接口；顶栏指示灯每 5s 探一次，必须用不读盘的轻量端点。
 *
 * 只在开发期有意义：生产构建里 DEV 为 false，不存在这个中间件，
 * 但静态站也可能被部署到别处后仍未连上本地服务，故**不按 DEV 短路**，
 * 一律以实际探测结果为准（404 会归到 `static`）。
 */
import { useEffect, useRef, useState } from "react";

/** 探测间隔（ms）：5s 兼顾"停服后能及时灭灯"与"不打满请求" */
const POLL_MS = 5000;
/** 单次探测超时（ms）：dev server 在跑时是毫秒级返回；2s 足够区分"没跑" */
const TIMEOUT_MS = 2000;
const HEALTH_ENDPOINT = "/api/health";

export type ServiceState = "checking" | "online" | "static" | "offline";

export interface ServiceHealth {
  state: ServiceState;
  /** 在线时 Node 版本（如 `v24.18.0`），其它态为 null */
  nodeVersion: string | null;
}

/** 单次探测：返回服务状态（不抛错） */
async function probe(): Promise<ServiceHealth> {
  try {
    const res = await fetch(HEALTH_ENDPOINT, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 405) {
      // 服务在，但没有这个端点 → 纯静态构建
      return { state: "static", nodeVersion: null };
    }
    if (!res.ok) return { state: "offline", nodeVersion: null };
    const data = (await res.json().catch(() => null)) as { ok?: unknown; node?: unknown } | null;
    if (data && data.ok === true) {
      return {
        state: "online",
        nodeVersion: typeof data.node === "string" ? data.node : null,
      };
    }
    return { state: "offline", nodeVersion: null };
  } catch {
    // 网络错误 / 超时：dev server 没跑或正在重启
    return { state: "offline", nodeVersion: null };
  }
}

/** 周期探测本地服务状态；首帧为 `checking`，探测回来即更新 */
export function useServiceHealth(): ServiceHealth {
  const [health, setHealth] = useState<ServiceHealth>({
    state: "checking",
    nodeVersion: null,
  });
  /** 卸载标记：异步回来时组件可能已卸（StrictMode 下会跑两轮 effect） */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const tick = async () => {
      const next = await probe();
      if (aliveRef.current) setHealth(next);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, []);

  return health;
}

/** 指示灯文案（顶栏用） */
export function serviceLabel(state: ServiceState): string {
  if (state === "online") return "本地服务 · 已连接";
  if (state === "static") return "本地服务 · 静态构建";
  if (state === "offline") return "本地服务 · 未连接";
  return "本地服务 · 检测中";
}

/** 悬停说明：讲清这个灯代表什么、以及当前状态下什么可用 */
export function serviceTitle(health: ServiceHealth): string {
  const { state, nodeVersion } = health;
  if (state === "online") {
    const ver = nodeVersion ? `（Node ${nodeVersion}）` : "";
    return `本地服务在线${ver}：需要 Node 侧的功能都可用——「在文件夹中打开」、图库注册表登记路径、识图供应商代理、模块组件安装。`;
  }
  if (state === "static") {
    return "当前是静态页面（没有本地 dev server）：看图库、画布、分析、超分等前台功能都可用，但「在文件夹中打开」、图库注册表登记路径、识图代理与组件安装需要本地服务。用 scripts\\start-web.bat 启动即可。";
  }
  if (state === "offline") {
    return "连不上本地服务：dev server 可能没启动、正在启动，或已退出。用 scripts\\start-web.bat 启动（双击即可）。";
  }
  return "正在检测本地服务…";
}
