import type { TeamChart } from "@hive/shared";
import type { EventStore } from "../store/eventStore.js";

export interface BudgetCheckOk {
  ok: true;
}
export interface BudgetCheckExceeded {
  ok: false;
  reason: string;
  usedUsd: number;
  limitUsd: number;
}
export type BudgetCheck = BudgetCheckOk | BudgetCheckExceeded;

const utcDate = (ts: string) => ts.slice(0, 10);

/**
 * 预算熔断（硬原则 3：诚实熔断）——门禁装在内核，不装在 bot 嘴里。
 * - 任务级：budgetUsd（task.created payload）
 * - bot 级：guards.daily_budget_usd（UTC 日历日）
 * 花费只信 cost.recorded 事件（由内核从引擎 usage 记账），bot 自报不作数。
 * 启动时从事件流回放重建花费——内核重启后预算照样算数（一切皆事件的红利）。
 */
export class BudgetGuard {
  private taskSpend = new Map<string, number>();
  private botSpendToday = new Map<string, number>();
  private today = utcDate(new Date().toISOString());

  constructor(
    private store: EventStore,
    private chart: TeamChart,
  ) {
    this.rebuild();
  }

  /** 从历史事件重建花费表 */
  rebuild(): void {
    this.taskSpend.clear();
    this.botSpendToday.clear();
    this.today = utcDate(new Date().toISOString());
    for (const e of this.store.allEvents()) {
      if (e.kind !== "cost.recorded") continue;
      const p = e.payload as { botId: string; usd: number };
      this.taskSpend.set(e.taskId, (this.taskSpend.get(e.taskId) ?? 0) + p.usd);
      if (utcDate(e.ts) === this.today) {
        this.botSpendToday.set(p.botId, (this.botSpendToday.get(p.botId) ?? 0) + p.usd);
      }
    }
  }

  /** spawn 前的门禁：任务预算或 bot 日额度已用尽 → 拒绝派工 */
  precheck(taskId: string, botId: string, taskBudgetUsd?: number): BudgetCheck {
    const role = this.chart.roles.find((r) => r.id === botId);
    const daily = role?.guards?.daily_budget_usd;
    if (daily != null) {
      const used = this.botSpendToday.get(botId) ?? 0;
      if (used >= daily) {
        return { ok: false, reason: `bot ${botId} 今日额度已用尽（$${fmt(used)}/$${fmt(daily)}）`, usedUsd: used, limitUsd: daily };
      }
    }
    if (taskBudgetUsd != null) {
      const used = this.taskSpend.get(taskId) ?? 0;
      if (used >= taskBudgetUsd) {
        return { ok: false, reason: `任务 #${taskId} 预算已用尽（$${fmt(used)}/$${fmt(taskBudgetUsd)}）`, usedUsd: used, limitUsd: taskBudgetUsd };
      }
    }
    return { ok: true };
  }

  /** 记账（cost.recorded 之后调用） */
  record(taskId: string, botId: string, usd: number): void {
    this.taskSpend.set(taskId, (this.taskSpend.get(taskId) ?? 0) + usd);
    this.botSpendToday.set(botId, (this.botSpendToday.get(botId) ?? 0) + usd);
  }

  /** 一轮跑完后的后检：实际花费超出任务预算 → 熔断暂停 */
  postcheck(taskId: string, taskBudgetUsd?: number): BudgetCheck {
    if (taskBudgetUsd == null) return { ok: true };
    const used = this.taskSpend.get(taskId) ?? 0;
    if (used > taskBudgetUsd) {
      return { ok: false, reason: `任务 #${taskId} 实际花费 $${fmt(used)} 超预算 $${fmt(taskBudgetUsd)}，自动暂停`, usedUsd: used, limitUsd: taskBudgetUsd };
    }
    return { ok: true };
  }
}

function fmt(n: number): string {
  return n.toFixed(2);
}
