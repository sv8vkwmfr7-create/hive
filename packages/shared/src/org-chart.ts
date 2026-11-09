import { z } from "zod";

/**
 * 组织即配置：team.json schema v1。
 * 目标：Hive 原生格式，passthrough 容忍 agent-org-chart chart.json 的额外字段。
 */

/** 引擎三系：CLI 进程 / API 网关 / 本地推理 */
export const EngineType = z.enum(["cli", "api", "local"]);
export type EngineType = z.infer<typeof EngineType>;

/** 引擎引用：架构图上蜂房里的那颗"脑"（换脑 = 换 engine 字段，团队行为不变） */
export const EngineRefSchema = z.object({
  type: EngineType,
  adapter: z.string().min(1),
  model: z.string().optional(),
});
export type EngineRef = z.infer<typeof EngineRefSchema>;

/** 角色档位护栏：内核强制执行，bot 无法自改 */
export const GuardsSchema = z.object({
  can_initiate_mention: z.boolean().default(false),
  daily_budget_usd: z.number().positive().optional(),
  max_turns: z.number().int().positive().optional(),
  /** 高风险动作强制过审批门（对外发送、花钱、合并、部署） */
  needs_approval_for: z.array(z.enum(["send_external", "spend", "merge", "deploy"])).optional(),
});
export type Guards = z.infer<typeof GuardsSchema>;

export const RoleKind = z.enum(["orchestrator", "specialist", "reviewer"]);
export type RoleKind = z.infer<typeof RoleKind>;

export const RoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: RoleKind,
  engine: EngineRefSchema,
  profile: z.string().min(1),
  /** —— 以下字段兼容 agent-org-chart chart.json —— */
  reports_to: z.string().optional(),
  in_scope: z.array(z.string()).optional(),
  out_of_scope: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  guards: GuardsSchema.optional(),
});
export type Role = z.infer<typeof RoleSchema>;

/** 流转规则：from→to 在 when 条件下交接 */
export const HandoffRuleSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.string().min(1),
});
export type HandoffRule = z.infer<typeof HandoffRuleSchema>;

/** team.json schema v1（passthrough：社区格式的未知字段原样保留，不丢信息） */
export const TeamChartSchema = z
  .object({
    schema_version: z.literal(1),
    team: z.string().min(1),
    roles: z.array(RoleSchema).min(1),
    handoffs: z.array(HandoffRuleSchema).default([]),
    channels: z.record(z.string(), z.unknown()).optional(),
    spawn: z.record(z.string(), z.unknown()).optional(),
    routines: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type TeamChart = z.infer<typeof TeamChartSchema>;

/** 结构校验（超出 schema 的语义规则）：恰好一个总管、handoff 引用存在且不自环、审核员不得主动发起 @ */
export function validateChart(chart: TeamChart): string[] {
  const errors: string[] = [];
  const orchestrators = chart.roles.filter((r) => r.kind === "orchestrator");
  if (orchestrators.length !== 1) {
    errors.push(`总管（orchestrator）必须恰好 1 个，实际 ${orchestrators.length}`);
  }
  const ids = new Set(chart.roles.map((r) => r.id));
  for (const h of chart.handoffs) {
    if (!ids.has(h.from)) errors.push(`handoff.from 引用不存在的角色：${h.from}`);
    if (!ids.has(h.to)) errors.push(`handoff.to 引用不存在的角色：${h.to}`);
    if (h.from === h.to) errors.push(`handoff 自环：${h.from}`);
  }
  for (const r of chart.roles) {
    if (r.kind === "reviewer" && r.guards?.can_initiate_mention) {
      errors.push(`审核员 ${r.id} 不得主动发起 @（onlyOrchestratorInitiatesMention）`);
    }
  }
  return errors;
}

const ORCHESTRATOR_KINDS = new Set(["orchestrator", "lead", "chief", "manager", "queen", "conductor"]);
const REVIEWER_KINDS = new Set(["reviewer", "auditor", "critic", "judge"]);

/**
 * agent-org-chart chart.json → Hive TeamChart 宽容导入。
 * 未知 kind 一律归为 specialist 并记 warning，不抛错（社区 11 套团队直接导入的产品承诺）。
 */
export function importAgentOrgChart(raw: unknown): { chart: TeamChart; warnings: string[] } {
  const warnings: string[] = [];
  const src = (raw ?? {}) as Record<string, unknown>;
  const team = typeof src.id === "string" ? src.id : typeof src.team === "string" ? src.team : "imported";
  const rawRoles = Array.isArray(src.roles) ? src.roles : [];
  const roles = rawRoles.map((r0: Record<string, unknown>, i: number) => {
    const kindRaw = typeof r0.kind === "string" ? r0.kind.toLowerCase() : "specialist";
    let kind: RoleKind = "specialist";
    if (ORCHESTRATOR_KINDS.has(kindRaw)) kind = "orchestrator";
    else if (REVIEWER_KINDS.has(kindRaw)) kind = "reviewer";
    else if (kindRaw !== "specialist") warnings.push(`roles[${i}].kind "${r0.kind}" 未识别，按 specialist 导入`);
    return RoleSchema.parse({
      ...r0,
      kind,
      id: typeof r0.id === "string" ? r0.id : `role_${i}`,
      name: typeof r0.name === "string" ? r0.name : (typeof r0.id === "string" ? r0.id : `role_${i}`),
      engine: r0.engine ?? { type: "cli", adapter: "mock" },
      profile: typeof r0.profile === "string" ? r0.profile : "profiles/导入.md",
      guards: r0.guards ?? { can_initiate_mention: kind === "orchestrator" },
    });
  });
  const rawHandoffs = Array.isArray(src.handoffs) ? src.handoffs : [];
  const handoffs = rawHandoffs.map((h0: Record<string, unknown>) => HandoffRuleSchema.parse(h0));
  const chart = TeamChartSchema.parse({ ...src, schema_version: 1, team, roles, handoffs });
  if (src.schema_version !== 1) warnings.push(`schema_version "${src.schema_version}" 非 1，已按 v1 导入`);
  return { chart, warnings };
}
