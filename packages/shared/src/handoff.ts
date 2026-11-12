import { z } from "zod";

/**
 * 交接协议：交接三要素、审核结论、治理硬规则。
 * 出处：hermes-group-chat-optimization 交接三要素 + grok-bot-profiles 生产者/审核者分离。
 */

/** 交接三要素：转交原因 + 当前进度 + 需要对方做什么。三者缺一不可。 */
export const HandoffNote = z.object({
  reason: z.string().min(1, "交接缺少要素：转交原因"),
  progress: z.string().min(1, "交接缺少要素：当前进度"),
  ask: z.string().min(1, "交接缺少要素：需要对方做什么"),
});
export type HandoffNote = z.infer<typeof HandoffNote>;

/** 审核结论：只有 PASS / BLOCK(带证据) / HOLD 三种，没有第四种；BLOCK 无证据视为非法。 */
export const ReviewVerdict = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("PASS") }),
  z.object({ verdict: z.literal("BLOCK"), evidence: z.string().min(1, "BLOCK 必须附证据") }),
  z.object({ verdict: z.literal("HOLD"), reason: z.string().min(1, "HOLD 必须说明原因") }),
]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/**
 * 引擎 verdict 字段错位纠偏（实测首跑抓到的失败模式：HOLD 配了 evidence，BLOCK 配了 reason）。
 * 说明文字是审核员真实说出的，只是放错了字段——内核不为字段名错位整单报废；
 * 纠偏后仍须过 ReviewVerdict 校验（BLOCK 无任何说明依旧非法，store 硬门禁不变）。
 */
export function normalizeVerdictInput(m: { verdict: string; evidence?: string; reason?: string }): {
  verdict: string;
  evidence?: string;
  reason?: string;
} {
  if (m.verdict === "HOLD" && !m.reason && m.evidence) return { verdict: m.verdict, reason: m.evidence };
  if (m.verdict === "BLOCK" && !m.evidence && m.reason) return { verdict: m.verdict, evidence: m.reason };
  return m;
}

/** 治理硬规则：写进 profiles 跨引擎通用，内核按此强制执行（不依赖 bot 自觉）。 */
export const GOVERNANCE = {
  /** 只有总管（orchestrator）可主动 @ 其他 bot，防 relay 死循环 */
  onlyOrchestratorInitiatesMention: true,
  /** 审核员必须独立会话（生产者/审核者物理分离） */
  reviewerIndependentSession: true,
  /** 交接 ≠ 审批 */
  handoffIsNotApproval: true,
  /** 永不自审：审核员不得审核自己产出的内容 */
  noSelfReview: true,
  /** 同一信息源禁止两个 bot 重复查 */
  noDuplicateSourceQueries: true,
} as const;
