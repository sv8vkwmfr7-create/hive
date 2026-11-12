import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  HandoffNote,
  ReviewVerdict,
  summarizeReceipt,
  validateChart,
} from "@hive/shared";
import type { TeamChart, TaskReceipt } from "@hive/shared";
import { EventStore } from "../store/eventStore.js";
import type { StoredEvent } from "../store/eventStore.js";
import { BudgetGuard } from "./budget.js";
import type { BudgetCheck } from "./budget.js";
import { runBot } from "../engine/runner.js";
import type { BotMsg } from "../engine/runner.js";

/** mock 引擎 worker 的位置（dist/core/kernel.js → 包根 bin/） */
const MOCK_WORKER = fileURLToPath(new URL("../../bin/worker-mock.mjs", import.meta.url));

/** 一个引擎 worker 的启动规格（适配器包提供：桥接脚本 + 契约文件 + 凭据环境） */
export interface WorkerSpec {
  workerPath: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface KernelOptions {
  dataDir: string;
  chart: TeamChart;
  /**
   * 共享大脑（Obsidian vault）：任务 PASS 后交付摘要自动落库，
   * 后续任务的 bot 接活先查库（vault 条目清单随任务包下发）。
   */
  vaultDir?: string;
  /**
   * 引擎解析器：adapterId → worker 规格。
   * 不提供或返回 null → 该引擎如实失败（不冒充可用）。默认只认 mock。
   */
  workers?: (adapterId: string) => WorkerSpec | null;
}

export interface RunResult {
  taskId: string;
  status: "ok" | "failed" | "paused";
  reason?: string;
  receipt?: TaskReceipt;
  /** 共享大脑落库文件路径（配置了 vaultDir 且任务 ok 时返回） */
  vaultPath?: string;
}

interface QueueItem {
  botId: string;
  instruction?: string;
  /** handoff 缺失重试门：true = 本轮是漏交棒后的自动重派，不再重试 */
  handoffRetry?: boolean;
}

interface PriorArtifact {
  botId: string;
  path: string;
}

/**
 * Hive 内核 v0：任务总线 + 事件溯源 + mock 引擎进程管理 + 预算熔断。
 *
 * 门禁（都在内核，bot 提议、内核裁决）：
 * - handoff 必须命中 chart.handoffs 里的一条边，否则拒绝
 * - 交接三要素缺一不可（HandoffNote）
 * - 只有 kind=reviewer 的 bot 能出审核结论；BLOCK(无证据) 协议违规
 * - 引擎不是 mock → 如实失败（不用 mock 冒充真引擎）
 * - 预算熔断：超限自动暂停，不硬烧
 * - 交付核验：没有审核 PASS 不算 ok；产物文件必须真实存在
 */
export class HiveKernel {
  readonly store: EventStore;
  private budget: BudgetGuard;
  private pausedTasks = new Set<string>();
  /** CEO ⏸️：人工暂停标记（runTask 循环在每个蜂房边界检查） */
  private manualPaused = new Set<string>();
  /** 暂停时未跑完的执行队列：resumeTask 从这里继续 */
  private pausedQueues = new Map<string, QueueItem[]>();
  /** 审批门：taskId → 待批动作 */
  private pendingApprovals = new Map<string, string>();
  private listeners = new Set<(e: StoredEvent) => void>();

  constructor(private opts: KernelOptions) {
    const errs = validateChart(opts.chart);
    if (errs.length) throw new Error(`团队架构图不合法：\n- ${errs.join("\n- ")}`);
    this.store = new EventStore(opts.dataDir);
    this.budget = new BudgetGuard(this.store, opts.chart);
  }

  /** 数据目录（server 读产物/账单文件用） */
  get dataDir(): string {
    return this.opts.dataDir;
  }

  /** 当前团队架构图（server /api/chart 用） */
  get chart(): TeamChart {
    return this.opts.chart;
  }

  /** 实时事件订阅（server 包推 Mission Control 用） */
  onEvent(fn: (e: StoredEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(taskId: string, actor: string, kind: string, payload: unknown): StoredEvent {
    const ev = this.store.append({ taskId, actor, kind, payload });
    for (const fn of this.listeners) fn(ev);
    return ev;
  }

  /** 建任务（actor=human；CEO 拍板入口） */
  createTask(input: { title: string; brief: string; budgetUsd?: number; source?: string }): string {
    const taskId = String(this.store.countKind("task.created") + 1);
    this.emit(taskId, "human", "task.created", {
      title: input.title,
      brief: input.brief,
      budgetUsd: input.budgetUsd,
      source: input.source,
    });
    return taskId;
  }

  /** 跑一个任务：总管接单 → 按 chart 边流转 → 独立审核 → 收货核验 → 账单落盘 */
  async runTask(taskId: string): Promise<RunResult> {
    const created = this.store.replayTaskEvents(taskId).find((e) => e.kind === "task.created");
    if (!created) throw new Error(`任务不存在：#${taskId}`);
    const brief = (created.payload as { brief: string }).brief;
    const orchestrator = this.opts.chart.roles.find((r) => r.kind === "orchestrator")!;

    this.emit(taskId, "kernel", "task.assigned", { from: "kernel", to: orchestrator.id, instruction: brief });

    const queue: QueueItem[] = [{ botId: orchestrator.id, instruction: brief }];
    return this.drain(taskId, queue, created);
  }

  /** CEO ⏸️：人工暂停。运行中的那只蜂跑完本回合，然后在蜂房边界停下 */
  pauseTask(taskId: string, by = "human"): void {
    if (!this.store.replayTaskEvents(taskId).some((e) => e.kind === "task.created")) {
      throw new Error(`任务不存在：#${taskId}`);
    }
    this.manualPaused.add(taskId);
    this.emit(taskId, "human", "run.paused", { reason: `人工暂停（⏸️）by ${by}` });
  }

  /** CEO ▶️：恢复——从暂停边界继续跑剩余队列 */
  async resumeTask(taskId: string, by = "human"): Promise<RunResult> {
    const queue = this.pausedQueues.get(taskId);
    if (!queue) {
      return {
        taskId,
        status: "failed",
        reason: "无可恢复的执行队列（任务未在人工暂停态；预算熔断的任务请调整预算后重新发起）",
      };
    }
    this.emit(taskId, "human", "run.resumed", {});
    this.manualPaused.delete(taskId);
    this.pausedQueues.delete(taskId);
    const created = this.store.replayTaskEvents(taskId).find((e) => e.kind === "task.created")!;
    return this.drain(taskId, queue, created);
  }

  /** CEO ✋：接管——人工直接给某只蜂派指令（须先 ⏸️ 暂停；只可派给架构图内的蜂房） */
  instructTask(taskId: string, botId: string, instruction: string, by = "human"): void {
    const role = this.opts.chart.roles.find((r) => r.id === botId);
    if (!role) throw new Error(`chart 中无此 bot：${botId}——接管派工只能派给架构图内的蜂房`);
    if (!instruction?.trim()) throw new Error("接管指令不能为空");
    const queue = this.pausedQueues.get(taskId);
    if (!queue) throw new Error(`任务 #${taskId} 不在人工暂停态：先 ⏸️ 暂停，再 ✋ 接管派工`);
    queue.unshift({ botId, instruction });
    this.emit(taskId, "human", "run.taken_over", { by });
    this.emit(taskId, "human", "task.assigned", { from: `human:${by}`, to: botId, instruction });
  }

  /** 审批门：当前任务的待批动作（无则 null） */
  pendingApproval(taskId: string): string | null {
    return this.pendingApprovals.get(taskId) ?? null;
  }

  /** CEO ✅：批准待批动作 → 该蜂带 approvals 重跑直至交付 */
  async approveTask(taskId: string, action: string, by = "human"): Promise<RunResult> {
    const pending = this.pendingApprovals.get(taskId);
    if (!pending) throw new Error(`任务 #${taskId} 没有待批动作`);
    if (pending !== action) throw new Error(`待批动作是 ${pending}，不是 ${action}`);
    this.emit(taskId, "human", "approval.granted", { action, by });
    this.pendingApprovals.delete(taskId);
    return this.resumeTask(taskId, by);
  }

  /** CEO ⛔：拒绝待批动作 → 任务如实失败，不静默放行 */
  denyTask(taskId: string, action: string, by = "human", reason?: string): void {
    const pending = this.pendingApprovals.get(taskId);
    if (!pending) throw new Error(`任务 #${taskId} 没有待批动作`);
    if (pending !== action) throw new Error(`待批动作是 ${pending}，不是 ${action}`);
    this.emit(taskId, "human", "approval.denied", { action, by, reason });
    this.pendingApprovals.delete(taskId);
    this.pausedQueues.delete(taskId);
    const msg = `审批被拒：${action}${reason ? `——${reason}` : ""}`;
    this.emit(taskId, "kernel", "task.status_changed", { to: "failed", reason: msg });
  }

  /** 本任务已获批准的动作清单（随任务包下发，重跑的蜂据此跳过再次请求） */
  private grantedActions(taskId: string): string[] {
    return this.store
      .replayTaskEvents(taskId)
      .filter((e) => e.kind === "approval.granted")
      .map((e) => (e.payload as { action: string }).action);
  }

  /** 执行队列主循环（runTask 与 resumeTask 共用）：每只蜂之间检查人工暂停门 */
  private async drain(taskId: string, queue: QueueItem[], created: StoredEvent): Promise<RunResult> {
    const budgetUsd = (created.payload as { budgetUsd?: number }).budgetUsd;
    let verdict: ReviewVerdict | null = null;
    // 暂停/恢复场景：从事件流恢复已有审核结论（如恢复前审核员已出 PASS/BLOCK）
    const prevVerdict = this.store.replayTaskEvents(taskId).find((e) => e.kind === "review.verdict");
    if (prevVerdict) {
      const v = prevVerdict.payload as { verdict: "PASS" | "BLOCK" | "HOLD"; evidence?: string };
      verdict =
        v.verdict === "PASS"
          ? { verdict: "PASS" }
          : v.verdict === "BLOCK"
            ? { verdict: "BLOCK", evidence: v.evidence ?? "" }
            : { verdict: "HOLD", reason: "（恢复前存在 HOLD）" };
    }
    let lastFailure: string | undefined;
    const onVerdict = (v: ReviewVerdict) => {
      verdict = v;
    };
    // TS 不会追踪回调内的赋值，直读 verdict 会被窄化成 null/never——经函数读取拿声明类型
    const getVerdict = (): ReviewVerdict | null => verdict;

    while (queue.length) {
      // CEO ⏸️ 门：蜂房边界检查——运行中的蜂已跑完，剩余队列存起来等 resume
      if (this.manualPaused.has(taskId)) {
        this.emit(taskId, "kernel", "run.paused", { reason: "人工暂停生效：停在蜂房边界" });
        this.pausedQueues.set(taskId, queue);
        return {
          taskId,
          status: "paused",
          reason: "人工暂停（⏸️）：已停在蜂房边界；▶️ resumeTask 或 ✋ instructTask 继续",
        };
      }
      const item = queue.shift()!;
      let pendingApproval: { action: string; risk: string } | null = null;
      const outcome = await this.runOne(
        taskId,
        item,
        budgetUsd,
        onVerdict,
        (next) => queue.push(next),
        (f) => {
          lastFailure = f;
        },
        (a) => {
          pendingApproval = a;
        },
      );
      if (outcome === "handoff-retry") {
        // 合规率门重派：同一蜂带 handoffRetry 标记重跑，prompt 强调必须交棒
        queue.unshift({ botId: item.botId, instruction: item.instruction, handoffRetry: true });
        this.emit(taskId, "kernel", "error.reported", {
          message: `bot ${item.botId} 漏 handoff（未交棒）——合规率门自动重派一次`,
          byBot: item.botId,
        });
        continue;
      }
      if (outcome === "approval") {
        // 审批门：当前蜂排回队首，批准后带 approvals 重跑；拒绝则任务失败
        queue.unshift(item);
        const a = pendingApproval!;
        this.emit(taskId, "kernel", "run.paused", { reason: `等待审批：${a.action}（${a.risk}）` });
        this.pausedQueues.set(taskId, queue);
        this.pendingApprovals.set(taskId, a.action);
        return { taskId, status: "paused", reason: `等待审批：${a.action}` };
      }
      if (outcome === "paused") {
        return { taskId, status: "paused", reason: "预算熔断，自动暂停（见 budget.exceeded / run.paused）" };
      }
      if (outcome === "failed") {
        const reason = lastFailure ?? "执行失败";
        this.emit(taskId, "kernel", "task.status_changed", { to: "failed", reason });
        return { taskId, status: "failed", reason };
      }
      const v = getVerdict();
      if (v && v.verdict === "BLOCK") {
        const reason = `审核 BLOCK：${v.evidence ?? "（无证据）"}`;
        this.emit(taskId, "kernel", "task.status_changed", { to: "failed", reason });
        return { taskId, status: "failed", reason };
      }
    }

    // 收货核验（诚实原则）：没有 PASS 不算交付；产物必须真实存在
    const finalVerdict = getVerdict();
    if (!finalVerdict || finalVerdict.verdict !== "PASS") {
      const reason = "流水线跑完但没有审核 PASS，如实标失败，不谎报成功";
      this.emit(taskId, "kernel", "task.status_changed", { to: "failed", reason });
      return { taskId, status: "failed", reason };
    }
    const missing = this.store
      .replayTaskEvents(taskId)
      .filter((e) => e.kind === "artifact.produced")
      .map((e) => (e.payload as { path: string }).path)
      .filter((p) => !existsSync(p));
    if (missing.length) {
      const reason = `产物文件缺失：${missing.join(", ")}`;
      this.emit(taskId, "kernel", "task.status_changed", { to: "failed", reason });
      return { taskId, status: "failed", reason };
    }

    this.emit(taskId, "kernel", "task.status_changed", { to: "ok", reason: "审核 PASS，产物核验通过" });
    const receipt = this.writeReceipt(taskId);
    const vaultPath = this.opts.vaultDir ? this.writeVaultDigest(taskId, created, receipt) : undefined;
    return { taskId, status: "ok", receipt, vaultPath };
  }

  private async runOne(
    taskId: string,
    item: QueueItem,
    budgetUsd: number | undefined,
    onVerdict: (v: ReviewVerdict) => void,
    enqueue: (next: QueueItem) => void,
    onFail: (reason: string) => void,
    onApproval: (a: { action: string; risk: string }) => void,
  ): Promise<"ok" | "paused" | "failed" | "approval" | "handoff-retry"> {
    const role = this.opts.chart.roles.find((r) => r.id === item.botId)!;

    // 门禁 1：预算预检
    const pre = this.budget.precheck(taskId, role.id, budgetUsd);
    if (!pre.ok) {
      this.emit(taskId, "kernel", "budget.exceeded", { usedUsd: pre.usedUsd, limitUsd: pre.limitUsd });
      this.emit(taskId, "kernel", "run.paused", { reason: pre.reason });
      this.pausedTasks.add(taskId);
      return "paused";
    }

    // 门禁 2：引擎可用性——解析不到 worker 规格就如实失败，不用 mock 冒充
    let spec: WorkerSpec | null;
    if (role.engine.adapter === "mock") {
      spec = { workerPath: MOCK_WORKER };
    } else {
      spec = this.opts.workers?.(role.engine.adapter) ?? null;
    }
    if (!spec) {
      const msg = `引擎 ${role.engine.adapter} 适配器尚未接入（见 docs/引擎清单.md），如实失败`;
      this.emit(taskId, role.id, "error.reported", { message: msg, byBot: role.id, fatal: true });
      onFail(msg);
      return "failed";
    }

    this.emit(taskId, "kernel", "bot.spawned", { botId: role.id, engine: role.engine });

    const priorArtifacts: PriorArtifact[] = this.store
      .replayTaskEvents(taskId)
      .filter((e) => e.kind === "artifact.produced")
      .map((e) => (e.payload as { path: string }).path)
      .map((path, i) => ({ botId: `prior_${i}`, path }));
    const artifactDir = join(this.opts.dataDir, "artifacts", taskId);
    mkdirSync(artifactDir, { recursive: true });

    // 协议级失败（非法交接/谎报产物/违规结论等）：内核记 error.reported，runOne 收尾统一裁决
    let failure: string | undefined;
    const fail = (msg: string): void => {
      if (failure) return;
      failure = msg;
      this.emit(taskId, role.id, "error.reported", { message: msg, byBot: role.id, fatal: true });
    };

    let askedApproval: string | undefined;
    // 合规率门：本轮运行是否发出过 handoff（specialist 漏交棒 → 重试门）
    let handoffEmitted = false;
    const res = await runBot({
      workerPath: spec.workerPath,
      args: spec.args,
      env: spec.env,
      maxTurns: role.guards?.max_turns ?? 50,
      stdinPayload: {
        taskId,
        botId: role.id,
        role: role.kind,
        instruction: item.instruction ?? "",
        artifactDir,
        inputArtifacts: priorArtifacts,
        // 本 bot 的合法派单链（chart 边）：提示词讲规矩的依据，真正的强制仍在门禁 3
        handoffs: this.opts.chart.handoffs
          .filter((h) => h.from === role.id)
          .map((h) => ({ to: h.to, when: h.when })),
        // 共享大脑：接活先查库——知识库已有条目随任务包下发
        vault: this.vaultEntries(),
        // 审批门：本任务已获批准的动作（重跑的蜂据此跳过再次请求）
        approvals: this.grantedActions(taskId),
        // 角色护栏：哪些动作需要 CEO 审批（提示词讲规矩，强制在审批门）
        needsApprovalFor: role.guards?.needs_approval_for ?? [],
        // 重派标记：提示词会强调本轮必须交棒
        handoffRetry: item.handoffRetry === true,
      },
      onMsg: (m: BotMsg) => {
        switch (m.type) {
          case "output":
            this.emit(taskId, role.id, "bot.output", { botId: role.id, chunk: m.chunk });
            return;
          case "handoff": {
            // 门禁 3：handoff 必须命中 chart 边 + 交接三要素齐全
            const hasEdge = this.opts.chart.handoffs.some((h) => h.from === role.id && h.to === m.to);
            if (!hasEdge) {
              fail(`bot ${role.id} 试图交接到 ${m.to}，chart 中无此边，内核拒绝`);
              return;
            }
            const note = HandoffNote.safeParse(m.note);
            if (!note.success) {
              fail(`交接三要素缺失：${note.error.issues.map((i) => i.message).join("; ")}`);
              return;
            }
            this.emit(taskId, role.id, "handoff.created", { from: role.id, to: m.to, note: note.data });
            handoffEmitted = true;
            enqueue({ botId: m.to });
            return;
          }
          case "artifact": {
            // 门禁 4：bot 报告的产物必须真实存在（谎报产物 = 失败）
            if (!existsSync(m.path)) {
              fail(`bot ${role.id} 谎报产物：${m.path} 不存在`);
              return;
            }
            this.emit(taskId, role.id, "artifact.produced", { path: m.path, kind: m.kind });
            return;
          }
          case "approval": {
            // 门禁 7：高风险动作先过审批门——内核挂起任务，等 CEO 批准/拒绝
            const risk = m.risk === "low" || m.risk === "medium" ? m.risk : "high";
            askedApproval = m.action;
            this.emit(taskId, role.id, "approval.requested", { action: m.action, risk });
            onApproval({ action: m.action, risk });
            return;
          }
          case "usage": {
            this.emit(taskId, "kernel", "cost.recorded", {
              botId: role.id,
              engine: role.engine.adapter,
              model: m.model,
              tokensIn: m.tokensIn,
              tokensOut: m.tokensOut,
              usd: m.usd,
            });
            this.budget.record(taskId, role.id, m.usd);
            return;
          }
          case "verdict": {
            if (askedApproval) {
              // 先批后审：同回合既请求审批又出结论 → 结论丢弃（不落流不入账），记非致命违规，审批流继续。
              // 与合规率门同一哲学：引擎偶发双发不整单报废——批准重跑后该蜂自然出干净结论。
              this.emit(taskId, "kernel", "error.reported", {
                message: `bot ${role.id} 同回合既请求审批又出审核结论——按「先批后审」丢弃结论，仅保留审批请求`,
                byBot: role.id,
                fatal: false,
              });
              return;
            }
            // 门禁 5：只有审核员能出结论，且用 shared 的 ReviewVerdict（BLOCK 必须带证据）
            if (role.kind !== "reviewer") {
              fail(`非审核员 bot ${role.id} 试图出审核结论，内核拒绝`);
              return;
            }
            const v = ReviewVerdict.safeParse({ verdict: m.verdict, evidence: m.evidence, reason: m.reason });
            if (!v.success) {
              fail(`审核结论不合法：${v.error.issues.map((i) => i.message).join("; ")}`);
              return;
            }
            const verdict: ReviewVerdict =
              v.data.verdict === "PASS"
                ? { verdict: "PASS" }
                : v.data.verdict === "BLOCK"
                  ? { verdict: "BLOCK", evidence: v.data.evidence! }
                  : { verdict: "HOLD", reason: v.data.reason! };
            this.emit(taskId, role.id, "review.verdict", {
              verdict: verdict.verdict,
              reviewer: role.id,
              evidence: "evidence" in verdict ? verdict.evidence : "reason" in verdict ? verdict.reason : undefined,
            });
            onVerdict(verdict);
            return;
          }
        }
      },
    });

    // 收尾裁决：协议失败 > 进程退出码 > 合规率门（漏交棒重试）> 预算后检；任一命中即如实处置
    if (failure) {
      onFail(failure);
      return "failed";
    }
    if (res.killed || res.code !== 0) {
      const msg = res.killed ? res.stderrTail : `bot ${role.id} 异常退出 code=${res.code}：${res.stderrTail.slice(-300)}`;
      this.emit(taskId, role.id, "error.reported", { message: msg, byBot: role.id, fatal: true });
      onFail(msg);
      return "failed";
    }
    if (askedApproval) return "approval";

    // 合规率门：专业岗漏交棒（有出边、本轮没发 handoff、非重试轮）→ 返回重派信号
    // 无人干预完成率 ≥80% 指标的内核手段：引擎偶发漏交棒不再导致整单失败
    const hasOutbound = this.opts.chart.handoffs.some((h) => h.from === role.id);
    if (role.kind === "specialist" && hasOutbound && !handoffEmitted && !item.handoffRetry) {
      this.emit(taskId, "kernel", "bot.exited", { botId: role.id, code: 0 });
      return "handoff-retry";
    }

    this.emit(taskId, "kernel", "bot.exited", { botId: role.id, code: 0 });

    // 门禁 6：预算后检（本轮实际花费可能超任务预算 → 熔断暂停，不硬烧）
    const post: BudgetCheck = this.budget.postcheck(taskId, budgetUsd);
    if (!post.ok) {
      this.emit(taskId, "kernel", "budget.exceeded", { usedUsd: post.usedUsd, limitUsd: post.limitUsd });
      this.emit(taskId, "kernel", "run.paused", { reason: post.reason });
      this.pausedTasks.add(taskId);
      return "paused";
    }
    return "ok";
  }

  /** 账单落盘（工资单：每单必有） */
  writeReceipt(taskId: string): TaskReceipt {
    const entries = this.store
      .replayTaskEvents(taskId)
      .filter((e) => e.kind === "cost.recorded")
      .map((e) => ({
        taskId,
        ...(e.payload as { botId: string; engine: string; model?: string; tokensIn?: number; tokensOut?: number; usd: number }),
        ts: e.ts,
      }));
    const receipt = summarizeReceipt(taskId, entries);
    const ledgerDir = join(this.opts.dataDir, "ledger");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, `task-${taskId}.receipt.json`), JSON.stringify(receipt, null, 2), "utf8");
    return receipt;
  }

  isPaused(taskId: string): boolean {
    return (
      this.pausedTasks.has(taskId) ||
      this.manualPaused.has(taskId) ||
      this.pausedQueues.has(taskId) ||
      this.pendingApprovals.has(taskId)
    );
  }

  /** 共享大脑：知识库已有条目（文件名 + frontmatter 语义，bot 接活先查库并判断相关性）。扫根目录与一级子目录 */
  private vaultEntries(): Array<{ name: string; title?: string; tags?: string[]; date?: string }> {
    const dir = this.opts.vaultDir;
    if (!dir || !existsSync(dir)) return [];
    const parseEntry = (fullPath: string, name: string) => {
      const entry: { name: string; title?: string; tags?: string[]; date?: string } = { name };
      try {
        // 只读文件头 800 字符解析 frontmatter，避免大文件 IO
        const head = readFileSync(fullPath, "utf8").slice(0, 800);
        const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fm) {
          const title = fm[1].match(/^title:\s*(.+)$/m);
          if (title) entry.title = title[1].trim();
          const date = fm[1].match(/^date:\s*(.+)$/m);
          if (date) entry.date = date[1].trim();
          const tags = fm[1].match(/^tags:\s*\[(.*)\]$/m);
          if (tags) entry.tags = tags[1].split(",").map((t) => t.trim()).filter(Boolean);
        }
      } catch {
        // frontmatter 解析失败不影响条目列出
      }
      return entry;
    };
    const list: Array<{ name: string; title?: string; tags?: string[]; date?: string }> = [];
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(".md")) list.push(parseEntry(join(dir, e.name), e.name));
        // 落库目录（蜂巢交付/）在子目录里——也要进查库视野
        if (e.isDirectory()) {
          const sub = join(dir, e.name);
          for (const f of readdirSync(sub, { withFileTypes: true })) {
            if (f.isFile() && f.name.endsWith(".md")) list.push(parseEntry(join(sub, f.name), `${e.name}/${f.name}`));
          }
        }
      }
    } catch {
      // 目录不可读 → 返回已收集部分
    }
    return list;
  }

  /**
   * 共享大脑落库：任务 PASS 后把交付摘要（含产物全文与账单）写成 markdown 落 vault。
   * 这份文件就是"团队越用越强"的资产：后续任务的 bot 接活先查库，避免重复劳动。
   */
  writeVaultDigest(taskId: string, created: StoredEvent, receipt: TaskReceipt): string {
    const dir = join(this.opts.vaultDir!, "蜂巢交付");
    mkdirSync(dir, { recursive: true });
    const p = created.payload as { title?: string; brief?: string };
    const title = p.title ?? `任务 #${taskId}`;
    const safe = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
    const events = this.store.replayTaskEvents(taskId);
    const artifacts = events
      .filter((e) => e.kind === "artifact.produced")
      .map((e) => (e.payload as { path: string }).path);
    const handoffs = events.filter((e) => e.kind === "handoff.created");
    const verdict = events.find((e) => e.kind === "review.verdict");

    const lines: string[] = [
      "---",
      `title: ${title}`,
      `task: ${taskId}`,
      `date: ${new Date().toISOString().slice(0, 10)}`,
      "status: ok",
      `cost_usd: ${receipt.totalUsd}`,
      "tags: [蜂巢交付]",
      "---",
      "",
      `# ${title}`,
      "",
      `> ${p.brief ?? ""}`,
      "",
      "## 流转",
    ];
    for (const h of handoffs) {
      const n = h.payload as { from: string; to: string };
      lines.push(`- ${h.actor} → ${n.to}`);
    }
    if (verdict) {
      const v = verdict.payload as { verdict: string; evidence?: string };
      lines.push(`- 审核：${v.verdict}${v.evidence ? `（${v.evidence}）` : ""}`);
    }
    lines.push("", "## 账单", "");
    for (const c of receipt.entries) {
      lines.push(`- ${c.botId}（${c.engine}）：${c.tokensIn ?? 0} 入 / ${c.tokensOut ?? 0} 出 tokens，$${c.usd}`);
    }
    lines.push("", "## 交付物", "");
    for (const path of artifacts) {
      lines.push(`### ${path.split(/[\\/]/).at(-1)}`, "");
      try {
        lines.push(readFileSync(path, "utf8").slice(0, 8000));
      } catch {
        lines.push(`（文件不可读：${path}）`);
      }
      lines.push("");
    }
    const file = join(dir, `task-${taskId}-${safe}.md`);
    writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }
}
