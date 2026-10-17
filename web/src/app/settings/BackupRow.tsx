import { useState } from "react";
import { restartBackupTimer, runBackup, stopBackup, useBackupStore } from "../backup";

/**
 * 设置中心 → 通用 · 图库索引备份行（2026-09-24 任务卡）：
 * 开关 + 间隔档（5/10/30/60 分钟，默认 10）+ 立即备份按钮 + 状态行。
 * 备份对象 = 注册表中权限 granted 的图库的 .ystk 核心索引文件
 * （meta.json / index.json / vectors.bin，不含 thumbs），
 * 写入 devdata/backup/<库名>--<libraryId>/latest/，另保留两代 history。
 * 样式全部复用 sc-devlog__* / sc-seg / sc-cmp__btn 既有类。
 * 注：说明段落按用户口径省略（同日「删掉设置里对日志的描述」一致）；
 * 开关右侧短提示保留。
 */
const INTERVALS = [5, 10, 30, 60];

export function BackupRow() {
  const enabled = useBackupStore((s) => s.enabled);
  const intervalMin = useBackupStore((s) => s.intervalMin);
  const lastAt = useBackupStore((s) => s.lastAt);
  const lastResult = useBackupStore((s) => s.lastResult);
  const [busy, setBusy] = useState(false);

  const toggle = (on: boolean) => {
    if (on) {
      useBackupStore.setState({ enabled: true });
      restartBackupTimer();
    } else {
      useBackupStore.setState({ enabled: false });
      stopBackup();
    }
  };

  const pickInterval = (min: number) => {
    useBackupStore.setState({ intervalMin: min });
    restartBackupTimer(); // 开着才有效（内部判 enabled）
  };

  const runNow = () => {
    setBusy(true);
    void runBackup(true).finally(() => setBusy(false));
  };

  const lastTime = lastAt
    ? new Date(lastAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "—";

  return (
    <section className="sc-devlog">
      <div className="sc-row">
        <span className="sc-row__label">图库索引备份</span>
        <div className="sc-switch">
          <span className="sc-row__hint">仅备份图库索引，保留最近 3 代；不含原图、画布与设置</span>
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
            <span className="sc-devlog__label">备份间隔</span>
            <div className="sc-seg" role="group" aria-label="备份间隔">
              {INTERVALS.map((min) => (
                <button
                  key={min}
                  type="button"
                  className={intervalMin === min ? "is-active" : ""}
                  aria-pressed={intervalMin === min}
                  onClick={() => pickInterval(min)}
                >
                  {min} 分钟
                </button>
              ))}
            </div>
            <div className="sc-devlog__ops">
              <button
                type="button"
                className="sc-cmp__btn"
                disabled={busy}
                onClick={runNow}
                title="立即检查全部可访问图库并备份有变更的"
              >
                {busy ? "备份中…" : "立即备份"}
              </button>
            </div>
          </div>
          <div className="sc-devlog__line">
            <span className="sc-devlog__label">状态</span>
            <span className="sc-devlog__value">
              {lastResult ? `上次 ${lastTime} · ${lastResult}` : "尚未备份过（开启后按间隔自动进行）"}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
