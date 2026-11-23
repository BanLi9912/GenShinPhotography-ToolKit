/**
 * M3.5.2 识图队列（调度钉死）：仅新增/修改触发、并发 worker 池（默认 3，钳 1–5）、
 * 失败重试 3 次指数退避（默认 [1000,2000,4000]）、可中止（abortVisionRun）、
 * 跳过标记（visionVersion=-1）防重、实时 token+金额成本与累计、
 * 预算限额（budgetLimit>0：每再花满一个限额暂停提醒一次——金额与总任务挂钩不清零，
 *  blockedReason 回报；2026-09-03 口径）。
 * M3.5.3.2 起为逐任务队列（tasks 状态机）：本轮启动由 pending 生成 tasks（同序全 waiting），
 * takeNext 游标取第一个 waiting；running 中可经 enqueueVisionItems 连续加入/插队、
 * dequeueVisionItem 移除 waiting 任务；中止/预算/代次退出把仍 running 的 task 重置回
 * waiting（不计失败不写 -1，下轮可继续）。
 * M3.5.3.4 续跑语义：opts.resume 传入旧任务帧 → tasks 直接沿用（同引用进入 ActiveRun 演进）、
 * done/failed 由传入任务统计、成本/errors 全继承（total 不变），「继续识图/重试失败项」走此路径；
 * 60s 超时与外部中止分链——超时是普通可重试失败（analyze.ts 报请求超时文案），仅外部中止
 * （abortVisionRun(reason)）退出全队列，原因经终态 progress.abortReason 带出（内存态不进 schema）。
 * 旧 priorityIds/claimed 互斥机制删除，
 * 互斥改由 task.status 承担。
 * 对齐 pipeline/queue.ts 的代次守卫/flush 收尾/进度口径，但改并发 worker 池；
 * 请求一律经 analyzeOne（禁止绕过——setProviderRegion 写入在其内部）。
 */

import {
  currentGeneration,
  flush,
  getItem,
  listItems,
  updateItem,
} from "../index/indexFile";
import { analyzeOne, VISION_VERSION } from "./analyze";
import type { VisionRunResult } from "./analyze";
import type { LibraryIndexItem } from "../index/indexFile";
import { getProvider } from "./providers";
import { addVisionCostTotal, loadVisionGlobal } from "./settings";

export interface VisionQueueCost {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  amount: number;
}

export interface VisionQueueError {
  id: string;
  relPath: string;
  error: string;
}

/** M3.5.3.2 逐任务状态（不可变替换：迁移时 tasks[i] = { ...tasks[i], … }，保证 React 引用比较生效） */
export interface VisionTask {
  id: string;
  relPath: string;
  status: "waiting" | "running" | "done" | "failed";
  error?: string; // failed 时填
  forceOriginal?: boolean; // 机制保留（analyze.ts 支持）；当前无入口设置——一律按图库压缩档位（2026-08-23 用户口径）
}

export interface VisionQueueProgress {
  total: number;
  done: number;
  failed: number;
  running: boolean;
  cost: VisionQueueCost;
  /** M3.5.3.2 本轮逐任务状态；终态留在最后一帧 progress 里供 UI 展示（刷新即失，不落盘） */
  tasks: VisionTask[];
  /** 本轮终败采集（cap 50，超出丢最旧）；只活在本轮内存，刷新即失（不落盘） */
  errors: VisionQueueError[];
  /** M3.5.3.4 本轮中止原因（外部中止经终态 progress 带出；正常跑完/预算命中为 null，内存态） */
  abortReason?: string | null;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000];

/** 本轮中止标记 + 进行中请求的 AbortController（abortVisionRun 统一触发） */
let abortFlag = false;
let activeController: AbortController | null = null;
/** M3.5.3.4 本轮中止原因：abortVisionRun(reason) 首次写入生效（内部级联/预算不覆盖首因）；
 *  runVisionQueue 每轮启动复位，终态 report 经 abortReason 字段带出（正常跑完为 null）。 */
let roundAbortReason: string | null = null;

/**
 * 本轮运行上下文（M3.5.3.2）：tasks/cursor/report 供 running 中 enqueue/dequeue 直接操作；
 * runVisionQueue 启动时赋值、结束（含中止）清空；无 activeRun 时入队/移除静默 return
 * （非 running 的启动路径在 store 侧走 launchVision）。
 */
interface ActiveRun {
  tasks: VisionTask[];
  cursor: number;
  report: (running: boolean) => void;
}
let activeRun: ActiveRun | null = null;

/**
 * 已插队未取走的优先级任务数（M3.5.3.2）：保证连续插队「先点先跑」（FIFO）——
 * 插队任务恒驻 cursor..cursor+backlog-1 区间（全 waiting），新插队排在其后；
 * 取走递减、移除递减、轮次结束清零。
 */
let priorityBacklog = 0;

/**
 * running 中把新条目加入本轮队列（M3.5.3.2 连续加入）：去重——已在 tasks 且未
 * done/failed（waiting/running）的跳过；done/failed 的允许重加（单图重跑连续点、
 * 失败重试场景）；id 不存在跳过；加入即 report。
 * priority=true 插到游标处（下一个被取；连续插队按先点先跑 FIFO 排在其后），false
 * 追加尾部；forceOriginal 机制保留但当前无入口设置——单图重跑/批量识图一律按
 * 图库压缩档位（2026-08-23 用户口径，原「插队重跑 = true」已废止）。
 */
export function enqueueVisionItems(
  ids: string[],
  opts?: { priority?: boolean; forceOriginal?: boolean },
): void {
  const run = activeRun;
  if (!run) return;
  for (const id of ids) {
    if (
      run.tasks.some(
        (t) => t.id === id && t.status !== "done" && t.status !== "failed",
      )
    ) {
      continue;
    }
    const item = getItem(id);
    if (!item) continue;
    const task: VisionTask = {
      id,
      relPath: item.relPath,
      status: "waiting",
      ...(opts?.forceOriginal ? { forceOriginal: true } : {}),
    };
    if (opts?.priority) {
      // 插到游标区（cursor + backlog：已插队未取走的排更前）；cursor 已在尾部则等效追加
      run.tasks.splice(
        Math.min(run.cursor + priorityBacklog, run.tasks.length),
        0,
        task,
      );
      priorityBacklog += 1;
    } else {
      run.tasks.push(task);
    }
  }
  run.report(true);
}

/**
 * 从本轮队列移除一个 waiting 任务（仅 waiting 可移除；running/done/failed 忽略）；移除即
 * report。waiting 任务恒在 cursor 及之后（takeNext 只前进、插队只插在 cursor 区），移除
 * 位置 ≥ cursor 时 cursor 无需调整；防御性处理 idx < cursor 的偏差；移除插队任务时
 * priorityBacklog 同步递减。
 */
export function dequeueVisionItem(id: string): void {
  const run = activeRun;
  if (!run) return;
  const idx = run.tasks.findIndex(
    (t) => t.id === id && t.status === "waiting",
  );
  if (idx < 0) return;
  run.tasks.splice(idx, 1);
  if (idx < run.cursor) {
    run.cursor -= 1;
  } else if (idx < run.cursor + priorityBacklog) {
    priorityBacklog -= 1; // 移除的是插队任务
  }
  run.report(true);
}

/**
 * 待识图判定（M3.5.3.2，批量识图用）：未跑 / 版本旧 / 文件已修改 / -1 失败。
 * 注意与队列内部 pending 过滤的差别：队列内部排除 -1（防自动重跑死循环）；
 * 本口径包含 -1（手动批量/失败重试场景，批量识图要覆盖失败重试）。
 */
export function isVisionPending(item: LibraryIndexItem): boolean {
  return (
    (item.visionVersion ?? 0) === -1 ||
    (item.visionVersion ?? 0) < VISION_VERSION ||
    (item.visionAt ?? 0) < item.mtime
  );
}

/** 中止本轮：abort 进行中请求 + 队列退出；reason = 外部中止逐字原因（首次写入生效，
 *  内部级联「请求被中止」与预算命中不覆盖首因，见 roundAbortReason） */
export function abortVisionRun(reason?: string): void {
  if (reason !== undefined && roundAbortReason === null) {
    roundAbortReason = reason;
  }
  abortFlag = true;
  activeController?.abort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runVisionQueue(
  dir: FileSystemDirectoryHandle,
  callbacks: { onProgress: (p: VisionQueueProgress) => void },
  opts?: {
    /** dev 注入桩（重试验收用），默认 analyzeOne */
    runOne?: typeof analyzeOne;
    /** 重试退避序列，默认 [1000, 2000, 4000] */
    backoffMs?: number[];
    /** 强制重跑指定条目（5.3 插队用）：无视 visionVersion（含 -1） */
    itemIds?: string[];
    /** 整轮强制原图（M3.5.3 单图重跑用）；task 级插队原图不受此影响、一律原图 */
    forceOriginal?: boolean;
    /** M3.5.3.4 续跑（继续识图/重试失败项）：tasks 沿用旧任务帧同引用演进，
     *  done/failed 由传入任务统计、cost/errors 以传入值初始化（errors 沿用 cap 50）。
     *  预算口径（2026-09-03 A 裁定 + 用户修正）：金额与总任务挂钩、续跑不清零——
     *  每再花满一个 budgetLimit 暂停提醒一次（提醒游标按块计，见 budgetBlockStart） */
    resume?: {
      tasks: VisionTask[];
      cost: VisionQueueCost;
      errors: VisionQueueError[];
    };
  },
): Promise<{ done: number; failed: number; blockedReason: string | null }> {
  abortFlag = false;
  roundAbortReason = null;
  const runOne = opts?.runOne ?? analyzeOne;
  const backoffMs = opts?.backoffMs ?? DEFAULT_BACKOFF;

  // 守卫：fake 始终放行（无 key 可自验全链路）；真实 provider 需总开关 + key。
  // 不满足时不再静默——按原因返回 blockedReason，UI 据其给出明确反馈
  // key 按当前供应商分流：自定义供应商用自己的 apiKey（2026-09-26 任务卡 §4.4③）
  const global = await loadVisionGlobal();
  const provider = getProvider(global.providerId);
  if (!provider.fakeResponse) {
    if (!global.enabled) {
      return { done: 0, failed: 0, blockedReason: "识图总开关未开启" };
    }
    const customKey = (global.customProviders ?? []).find(
      (p) => p.id === provider.id,
    )?.apiKey;
    if (!(customKey ?? global.apiKey)) {
      return { done: 0, failed: 0, blockedReason: "未填写 API Key" };
    }
  }

  // M3.5.3.4 续跑分叉：resume 传入 → tasks 直接采用传入数组（同引用进入 ActiveRun 演进，
  // 不从 pending 重建）、done/failed 由传入任务统计、cost/errors 继承传入值——
  // 续跑口径：waiting 续跑、done/failed/计数/成本/errors 全继承、total 不变；
  // 未传 → 现状：待处理口径（新增未跑/版本旧/文件已修改；-1 跳过防重；itemIds 传入时
  // 改为「id 在列表内」无视版本与 -1）从 pending 重建本轮 tasks。
  const resume = opts?.resume;
  const forceIds = opts?.itemIds;
  let tasks: VisionTask[];
  let done: number;
  let failed: number;
  let cost: VisionQueueCost;
  /** 本轮终败采集（cap 50，超出丢最旧） */
  let errors: VisionQueueError[];
  if (resume) {
    tasks = resume.tasks;
    done = resume.tasks.filter((t) => t.status === "done").length;
    failed = resume.tasks.filter((t) => t.status === "failed").length;
    // 金额与总任务挂钩、续跑不清零：成本全继承（同一批任务累计显示与落账）
    cost = { ...resume.cost };
    errors = [...resume.errors];
  } else {
    const pending = listItems().filter((it) => {
      if (forceIds) return forceIds.includes(it.id);
      return (
        (it.visionVersion ?? 0) !== -1 &&
        ((it.visionVersion ?? 0) < VISION_VERSION ||
          (it.visionAt ?? 0) < it.mtime)
      );
    });
    // M3.5.3.2：本轮 tasks（同序全 waiting）由 pending 生成；互斥改由 status 字段承担
    tasks = pending.map((it) => ({
      id: it.id,
      relPath: it.relPath,
      status: "waiting",
    }));
    done = 0;
    failed = 0;
    cost = {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      amount: 0,
    };
    errors = [];
  }

  const gen = currentGeneration();
  const controller = new AbortController();
  activeController = controller;
  // M3.5.3.4 收尾按「本轮增量」落累计成本：resume 继承的 done/cost 已被上一轮 totalize，
  // 基线在此刻打点，结束时只加超出基线的部分，避免继承值重复累进 vision-cost-total
  const baselineDone = done;
  const baselineCost = { ...cost };
  /** 预算提醒块起点（2026-09-03 A 裁定 + 用户修正）：金额与总任务挂钩、续跑不清零——
   *  每再花满一个 budgetLimit 暂停提醒一次；新开轮起点 0，resume 续跑以已累计
   *  cost.amount 为块起点（普通续跑若已在块内则继续累计，不重复触发） */
  const budgetBlockStart = resume ? resume.cost.amount : 0;
  /** 预算块命中（budgetLimit > 0 且本块新增 cost 达标）：按中止语义退出 */
  let budgetHit = false;

  const report = (running: boolean) =>
    callbacks.onProgress({
      total: tasks.length,
      done,
      failed,
      running,
      cost: { ...cost },
      tasks: [...tasks], // 浅拷贝：task 对象不可变替换，保证 React 引用比较生效
      errors: [...errors],
      abortReason: roundAbortReason, // 正常跑完恒 null；外部中止经终态 report 带出
    });

  activeRun = { tasks, cursor: 0, report };
  // 启动即报一轮：total 在首个条目完成前就进 store，
  // 小窗计数立刻显示「0/N」（否则首条 API 往返期间一直停在 0/0）
  report(true);

  /**
   * 共享取条目（并发 worker 池共用）：从 cursor 起找第一个 waiting → 置 running
   * （不可变替换）、cursor 前移、返回；找不到返回 null。
   * M3.5.3.6：取走即 report——任务在**发出请求之前**就已置 running，但启动那次 report
   * 早于 worker 取任务（那时全是 waiting）。若不在这里补报，store/UI 会一直停在
   * 「全部空心点」直到**第一条 API 返回**才突然出现黄点，中间这段窗口里"其实已经在飞"
   * 的行仍会被渲染成 waiting（带 ✕）——这正是用户报的"正在识图的任务后面还有删除按钮"。
   */
  const takeNext = (): VisionTask | null => {
    const run = activeRun;
    if (!run) return null;
    while (run.cursor < run.tasks.length) {
      const task = run.tasks[run.cursor];
      run.cursor += 1;
      if (task.status !== "waiting") continue;
      if (priorityBacklog > 0) priorityBacklog -= 1; // 取走的正是最早的插队任务
      const next: VisionTask = { ...task, status: "running" };
      run.tasks[run.cursor - 1] = next;
      // 立刻上报（每任务至多一次，并发 N 即每轮多 N 次）：让 UI 在任务发出的同一刻
      // 就把它显示为 running（黄点闪烁），#✕ 也随之隐藏，状态与"是否在飞"不再错开
      run.report(true);
      return next;
    }
    return null;
  };

  async function worker(): Promise<void> {
    for (;;) {
      if (abortFlag || controller.signal.aborted) return;
      if (currentGeneration() !== gen) return; // 代次守卫（对齐 pipeline/queue.ts）
      const task = takeNext();
      if (!task) return;

      let result: VisionRunResult | null = null;
      const attempts = 1 + backoffMs.length; // 至多 3 次重试（共 4 次尝试）
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (abortFlag || controller.signal.aborted) return;
        if (currentGeneration() !== gen) return;
        result = await runOne(dir, task.id, {
          signal: controller.signal,
          // 整轮强制原图（非 running 单图重跑）或 task 级插队原图（running 中插队，一律原图）
          forceOriginal:
            opts?.forceOriginal === true || task.forceOriginal === true,
        });
        if (result.ok) break;
        if (result.error === "aborted") {
          // 中止：不重试、不计失败、不写 -1，全队列退出。
          // 外部中止首因（如「手动中止」/「切换或打开图库」）由首个 abortVisionRun(reason)
          // 记录，此处只确认退出、不覆盖首因（roundAbortReason 首次写入生效）
          abortVisionRun("请求被中止");
          return;
        }
        if (attempt < attempts - 1) {
          await sleep(backoffMs[attempt] ?? backoffMs[backoffMs.length - 1]);
        }
      }
      if (!result) return;

      // 状态迁移：不可变替换（tasks[i] = { ...tasks[i], … }），保证 React 引用比较生效
      const idx = tasks.indexOf(task);
      if (result.ok) {
        if (idx >= 0) tasks[idx] = { ...tasks[idx], status: "done" };
        done += 1;
        const usage = result.usage ?? {
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
        };
        const cached = usage.cachedTokens ?? 0;
        const billableInput = Math.max(0, usage.promptTokens - cached);
        cost.promptTokens += usage.promptTokens;
        cost.completionTokens += usage.completionTokens;
        cost.cachedTokens += cached;
        cost.amount +=
          (billableInput * global.priceInput +
            cached * global.priceCached +
            usage.completionTokens * global.priceOutput) /
          1_000_000;
        report(true);
        // 预算限额（budgetLimit > 0 时）：按「提醒块」判定——本块新增金额
        // （cost.amount − 块起点）≥ limit 即暂停提醒一次（金额不清零、继续不清除，
        // 未跑条目不写 -1、不计 failed）
        if (
          global.budgetLimit > 0 &&
          cost.amount - budgetBlockStart >= global.budgetLimit
        ) {
          budgetHit = true;
          abortVisionRun();
          return;
        }
      } else {
        // 终败：失败原因进 errors（cap 50）并打 console（口径对齐 pipeline/queue.ts）。
        // 落索引分两种（2026-09-03 用户口径）：项无有效识图结果（未跑/version 0/此前 -1）
        // → 写 -1 跳过防重 + 记失败时刻；项已有成功结果（visionVersion>=1）→ 手动重跑失败
        // 不降级——保留原已识图身份与内容（小窗计数不掉、详情仍显示原识图时间），
        // 本次失败仅报本轮任务/错误列表，不进索引
        console.warn("[library] 识图失败，跳过", task.relPath, result.error);
        if (errors.length >= 50) errors.shift();
        errors.push({
          id: task.id,
          relPath: task.relPath,
          error: result.error ?? "unknown",
        });
        if (idx >= 0) {
          tasks[idx] = {
            ...tasks[idx],
            status: "failed",
            error: result.error ?? "unknown",
          };
        }
        const hadResult = (getItem(task.id)?.visionVersion ?? 0) >= 1;
        if (!hadResult) {
          updateItem(task.id, { visionVersion: -1, visionAt: Date.now() });
        }
        failed += 1;
        report(true);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(5, global.concurrency));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  // M3.5.3.2：中止/预算/代次退出路径——仍为 running 的 task 重置回 waiting
  // （不计失败、不写 -1，下轮「继续识图」从断点续跑；正常跑完时无 running 残留，零影响）
  for (let i = 0; i < tasks.length; i += 1) {
    if (tasks[i].status === "running") {
      tasks[i] = { ...tasks[i], status: "waiting" };
    }
  }
  // 轮次结束（含中止）清空 activeRun：入队/移除通道关闭；tasks 本体留在最后一帧
  // progress 里供 UI 展示（不跨轮残留引用）
  activeRun = null;
  priorityBacklog = 0;

  if (activeController === controller) activeController = null;
  // 收尾：flush + 本轮增量成本（仅本轮新增成功张数与金额——resume 继承部分已 totalize 过）+ 终态进度
  await flush();
  await addVisionCostTotal({
    promptTokens: Math.max(0, cost.promptTokens - baselineCost.promptTokens),
    completionTokens: Math.max(
      0,
      cost.completionTokens - baselineCost.completionTokens,
    ),
    cachedTokens: Math.max(0, cost.cachedTokens - baselineCost.cachedTokens),
    amount: Math.max(0, cost.amount - baselineCost.amount),
    images: Math.max(0, done - baselineDone),
  });
  report(false);
  return {
    done,
    failed,
    blockedReason: budgetHit
      ? `已达本轮预算上限 ¥${global.budgetLimit}（每满 ¥${global.budgetLimit} 暂停一次，点「继续识图」再跑 ¥${global.budgetLimit}）`
      : null,
  };
}
