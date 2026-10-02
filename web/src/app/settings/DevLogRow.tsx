import { useEffect, useState } from "react";
import { toast } from "../../ui/toast";
import { devLogStatus } from "../../core/diagnostics/logger";
import { disableDevLog, enableDevLog, useDevLogStore } from "../diagnostics";

/**
 * 设置中心 → 通用 · 开发者日志行（2026-09-24 任务卡 v2）：
 * 只有开关 + 状态行，没有任何按钮——落盘走 dev server 中间件直写仓库根
 * devdata/logs/，无目录选择、无授权。不做应用内查看面板（用户口径）：
 * 看日志直接开文件夹。
 * 状态用 1s 轮询拉 devLogStatus()——设置中心不开时本组件不挂载，零开销。
 */
export function DevLogRow() {
  const enabled = useDevLogStore((s) => s.enabled);
  const [stat, setStat] = useState(devLogStatus());

  useEffect(() => {
    const id = setInterval(() => setStat(devLogStatus()), 1000);
    return () => clearInterval(id);
  }, []);

  const toggle = (on: boolean) => {
    if (!on) {
      useDevLogStore.setState({ enabled: false });
      void disableDevLog();
      return;
    }
    useDevLogStore.setState({ enabled: true });
    enableDevLog();
    toast("开发者日志已开启（写入 devdata/logs/，需开发服务器运行）");
  };

  const flushTime = stat.lastFlushAt
    ? new Date(stat.lastFlushAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "—";

  return (
    <section className="sc-devlog">
      <div className="sc-row">
        <span className="sc-row__label">开发者日志</span>
        <div className="sc-switch">
          <span className="sc-row__hint">记录操作与异常，排查问题用，平时请关闭</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={"sc-switch__track" + (enabled ? " is-on" : "")}
            onClick={() => toggle(!enabled)}
          >
            <span className="sc-switch__knob" />
          </button>
        </div>
      </div>
      {enabled && (
        <div className="sc-devlog__panel">
          <div className="sc-devlog__line">
            <span className="sc-devlog__label">状态</span>
            <span className="sc-devlog__value">
              {stat.sinkError
                ? `写盘失败（开发服务器未运行？仅内存记录，共 ${stat.buffered} 条）`
                : stat.pending > 0
                  ? `已记录 ${stat.buffered} 条，待写盘 ${stat.pending} 条 · devdata/logs/${stat.file ?? ""}`
                  : `已记录 ${stat.buffered} 条 · devdata/logs/${stat.file ?? ""} · 最近写盘 ${flushTime}`}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
