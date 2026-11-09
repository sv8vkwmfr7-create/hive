import { z } from "zod";
import { HandoffNote } from "./handoff.js";
import { EngineRefSchema } from "./org-chart.js";

/**
 * 事件溯源：一切皆事件。
 * 落盘格式 JSONL（append-only）+ SQLite 索引；修正历史 = 追加新事件，禁止改写。
 */

/** 群内状态标记的机器表示：✅ ok / 🔄 running / ⛔ failed */
export const StatusMark = z.enum(["ok", "running", "failed"]);
export type StatusMark = z.infer<typeof StatusMark>;

export const STATUS_GLYPH: Record<StatusMark, string> = {
  ok: "✅",
  running: "🔄",
  failed: "⛔",
};

/** 审批风险等级：high 一律过审批门（对外发送、花钱、合并） */
export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** v1 已知事件类型。新增类型向后兼容：未注册 kind 仍可入账（append-only 不丢历史），解析时标 known=false */
export const EventKinds = [
  "task.created",
  "task.approved",
  "task.rejected",
  "task.assigned",
  "task.status_changed",
  "handoff.created",
  "artifact.produced",
  "review.verdict",
  "cost.recorded",
  "budget.exceeded",
  "budget.resumed",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "bot.spawned",
  "bot.exited",
  "bot.output",
  "message.received",
  "message.sent",
  "run.paused",
  "run.resumed",
  "run.taken_over",
  "error.reported",
] as const;
export type EventKind = (typeof EventKinds)[number];

/** 事件信封：统一外壳。seq 由内核全局单调分配；actor 取 role id / "human" / "kernel" / "<connector>:<user>" */
export const EventEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  id: z.string().uuid(),
  ts: z.string().datetime(),
  taskId: z.string().min(1),
  actor: z.string().min(1),
  kind: z.string().regex(/^[a-z][a-z_]*\.[a-z_]+$/),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** 已知事件的 payload 注册表（与 EventKinds 一一对应） */
const payloadSchemas = {
  "task.created": z.object({
    title: z.string().min(1),
    brief: z.string().min(1),
    budgetUsd: z.number().positive().optional(),
    source: z.string().optional(),
  }),
  "task.approved": z.object({ note: z.string().optional() }),
  "task.rejected": z.object({ reason: z.string().min(1) }),
  "task.assigned": z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    instruction: z.string().optional(),
  }),
  "task.status_changed": z.object({
    to: StatusMark,
    from: StatusMark.optional(),
    reason: z.string().optional(),
  }),
  "handoff.created": z.object({ from: z.string().min(1), to: z.string().min(1), note: HandoffNote }),
  "artifact.produced": z.object({ path: z.string().min(1), kind: z.string().optional() }),
  "review.verdict": z.object({
    verdict: z.enum(["PASS", "BLOCK", "HOLD"]),
    reviewer: z.string().min(1),
    evidence: z.string().optional(),
  }),
  "cost.recorded": z.object({
    botId: z.string().min(1),
    engine: z.string().min(1),
    model: z.string().optional(),
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    usd: z.number().nonnegative(),
  }),
  "budget.exceeded": z.object({ usedUsd: z.number().nonnegative(), limitUsd: z.number().positive() }),
  "budget.resumed": z.object({}),
  "approval.requested": z.object({ action: z.string().min(1), risk: RiskLevel }),
  "approval.granted": z.object({ action: z.string().min(1), by: z.string().min(1) }),
  "approval.denied": z.object({ action: z.string().min(1), by: z.string().min(1), reason: z.string().optional() }),
  "bot.spawned": z.object({ botId: z.string().min(1), engine: EngineRefSchema }),
  "bot.exited": z.object({ botId: z.string().min(1), code: z.number().int().optional() }),
  "bot.output": z.object({ botId: z.string().min(1), chunk: z.string() }),
  "message.received": z.object({ channel: z.string().min(1), sender: z.string().min(1), text: z.string() }),
  "message.sent": z.object({ channel: z.string().min(1), text: z.string() }),
  "run.paused": z.object({ reason: z.string().optional() }),
  "run.resumed": z.object({}),
  "run.taken_over": z.object({ by: z.string().min(1) }),
  "error.reported": z.object({
    message: z.string().min(1),
    byBot: z.string().optional(),
    fatal: z.boolean().optional(),
  }),
} as const satisfies Record<EventKind, z.ZodTypeAny>;

export type PayloadByKind = { [K in EventKind]: z.infer<(typeof payloadSchemas)[K]> };

export type KnownEvent<K extends EventKind = EventKind> = EventEnvelope & {
  kind: K;
  payload: PayloadByKind[K];
};

export function isKnownKind(kind: string): kind is EventKind {
  return (EventKinds as readonly string[]).includes(kind);
}

/**
 * 解析一条事件：信封必过；已知 kind 额外校验 payload；未知 kind 原样放行（append-only，不丢历史）。
 * 返回 error 表示 payload 校验失败——调用方（内核）应记 error.reported，而不是静默丢弃。
 */
export function parseEvent(raw: unknown): {
  event: EventEnvelope;
  known: boolean;
  payload: unknown;
  error?: z.ZodError;
} {
  const envelope = EventEnvelope.parse(raw);
  const kind = envelope.kind;
  const rawPayload = (raw as { payload?: unknown }).payload;
  if (!isKnownKind(kind)) return { event: envelope, known: false, payload: rawPayload };
  const parsed = payloadSchemas[kind].safeParse(rawPayload);
  if (!parsed.success) return { event: envelope, known: true, payload: rawPayload, error: parsed.error };
  return { event: { ...envelope, kind, payload: parsed.data } as KnownEvent, known: true, payload: parsed.data };
}
