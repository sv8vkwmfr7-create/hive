import { z } from "zod";

/**
 * 账本：每单必有账单。成本由内核从引擎 usage 解析后记账，bot 自己报的数字不作数。
 */

/** 单笔成本记录 */
export const CostEntry = z.object({
  taskId: z.string().min(1),
  botId: z.string().min(1),
  engine: z.string().min(1),
  model: z.string().optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  usd: z.number().nonnegative(),
  ts: z.string().datetime(),
  note: z.string().optional(),
});
export type CostEntry = z.infer<typeof CostEntry>;

/** 任务成本小票（工资单） */
export const TaskReceiptSchema = z.object({
  taskId: z.string().min(1),
  totalUsd: z.number().nonnegative(),
  entries: z.array(CostEntry),
  generatedAt: z.string().datetime(),
});
export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;

/** 汇总一个任务的成本小票 */
export function summarizeReceipt(
  taskId: string,
  entries: CostEntry[],
  now = new Date().toISOString(),
): TaskReceipt {
  return {
    taskId,
    totalUsd: entries.reduce((sum, e) => sum + e.usd, 0),
    entries,
    generatedAt: now,
  };
}

/** 按角色档位建议：给预算和档位做"这活 T1 就够"的判断依据（v0 先只报结构，策略后置 kernel） */
export const TierPlan = z.object({
  taskId: z.string().min(1),
  suggestedTier: z.enum(["T0", "T1", "T2", "T3"]),
  suggestedBudgetUsd: z.number().nonnegative(),
  reason: z.string().min(1),
});
export type TierPlan = z.infer<typeof TierPlan>;
