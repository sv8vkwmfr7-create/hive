import { STATUS_GLYPH } from "@hive/shared";
import type { HiveKernel } from "@hive/kernel";
import type { StoredEvent } from "@hive/kernel";

export interface TaskSummary {
  taskId: string;
  title: string;
  /** running / ok / failed / paused（run.paused 或 budget.exceeded 后无终态） */
  status: "running" | "ok" | "failed" | "paused";
  glyph: string;
  spendUsd: number;
  budgetUsd?: number;
  startedAt?: string;
  updatedAt?: string;
  eventCount: number;
  /** CEO 门：任务是否处于暂停态（人工暂停/审批挂起/熔断） */
  paused?: boolean;
  /** 审批门：待批动作（无则 null）——手机审批页的主数据源 */
  pendingApproval?: string | null;
}

/** 从单个任务的事件流推导视图模型（不信任缓存，只信事件） */
export function summarizeTask(events: StoredEvent[]): TaskSummary | null {
  const created = events.find((e) => e.kind === "task.created");
  if (!created) return null;
  const p = created.payload as { title: string; budgetUsd?: number };
  let spendUsd = 0;
  let status: TaskSummary["status"] = "running";
  let glyph = "🔄";
  let updatedAt = created.ts;
  for (const e of events) {
    updatedAt = e.ts;
    switch (e.kind) {
      case "cost.recorded":
        spendUsd += (e.payload as { usd: number }).usd;
        break;
      case "budget.exceeded":
      case "run.paused":
        if (status === "running") {
          status = "paused";
          glyph = "⏸️";
        }
        break;
      case "task.status_changed": {
        const to = (e.payload as { to: "ok" | "running" | "failed" }).to;
        status = to;
        glyph = STATUS_GLYPH[to];
        break;
      }
    }
  }
  return {
    taskId: created.taskId,
    title: p.title,
    status,
    glyph,
    spendUsd,
    budgetUsd: p.budgetUsd,
    startedAt: created.ts,
    updatedAt,
    eventCount: events.length,
  };
}

/** 全部任务摘要（看板任务列表），按编号倒序（新单在前） */
export function listTasks(kernel: HiveKernel): TaskSummary[] {
  const byTask = new Map<string, StoredEvent[]>();
  for (const e of kernel.store.allEvents()) {
    const list = byTask.get(e.taskId) ?? [];
    list.push(e);
    byTask.set(e.taskId, list);
  }
  const summaries = [...byTask.values()]
    .map(summarizeTask)
    .filter((s): s is TaskSummary => s != null)
    .map((s) => ({
      ...s,
      paused: kernel.isPaused(s.taskId),
      pendingApproval: kernel.pendingApproval(s.taskId),
    }));
  // 待批任务置顶（手机审批页的第一屏），其余按编号倒序
  return summaries.sort(
    (a, b) => Number(!!b.pendingApproval) - Number(!!a.pendingApproval) || Number(b.taskId) - Number(a.taskId),
  );
}
