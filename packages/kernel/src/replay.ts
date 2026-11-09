import { STATUS_GLYPH, summarizeReceipt } from "@hive/shared";
import type { CostEntry, TaskReceipt } from "@hive/shared";
import type { EventStore, StoredEvent } from "./store/eventStore.js";

export interface TimelineEntry {
  seq: number;
  ts: string;
  actor: string;
  kind: string;
  payload: unknown;
  glyph?: string;
}

export interface TaskReplay {
  taskId: string;
  timeline: TimelineEntry[];
  receipt: TaskReceipt;
  eventCount: number;
}

/**
 * 回放审计：任何一单，从事件流完整重建时间线 + 账单。
 * 事件来自 JSONL（唯一真相源），账单从 cost.recorded 重算——不信任任何缓存。
 */
export function replayTask(store: EventStore, taskId: string): TaskReplay {
  const events = store.replayTaskEvents(taskId);
  const timeline: TimelineEntry[] = events.map((e: StoredEvent) => ({
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    kind: e.kind,
    payload: e.payload,
    glyph:
      e.kind === "task.status_changed"
        ? STATUS_GLYPH[(e.payload as { to: "ok" | "running" | "failed" }).to]
        : e.kind === "review.verdict" && (e.payload as { verdict: string }).verdict === "PASS"
          ? "✅"
          : e.kind === "review.verdict" && (e.payload as { verdict: string }).verdict === "BLOCK"
            ? "⛔"
            : undefined,
  }));
  const entries: CostEntry[] = events
    .filter((e) => e.kind === "cost.recorded")
    .map((e) => ({ taskId, ...(e.payload as Omit<CostEntry, "taskId" | "ts">), ts: e.ts }));
  return {
    taskId,
    timeline,
    receipt: summarizeReceipt(taskId, entries),
    eventCount: events.length,
  };
}
