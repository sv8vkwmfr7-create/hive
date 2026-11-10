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

export const RoleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: RoleKind,
    engine: EngineRefSchema,
    profile: z.string().min(1),
    /** —— 以下字段兼容 agent-org-chart chart.json —— */
    reports_to: z.string().nullable().optional(),
    in_scope: z.array(z.string()).optional(),
    out_of_scope: z.array(z.string()).optional(),
    channels: z.array(z.string()).optional(),
    guards: GuardsSchema.optional(),
  })
  .passthrough();
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
 * 未知 kind 一律归为 specialist 并记 warning，不抛错（社区团队一键导入的产品承诺）。
 *
 * 忠实支持社区真实格式（serenakeyitan/agent-org-chart，schema v1）：
 * - handoffs 用 from_role_id/to_role_id（Hive 用 from/to）→ 自动归一
 * - channels 是数组 {id,name,member_role_ids} → 转 Hive 的 record
 * - roles 无 engine（平台无关图）→ 默认 mock 引擎，换脑在 Hive 里完成
 * - 图里可能没有 orchestrator（社区语义：导入的 agent 自己就是总管）
 *   → 合成「总管（导入）」蜂房，并把 reports_to 树转成派单边
 */
export function importAgentOrgChart(raw: unknown): { chart: TeamChart; warnings: string[] } {
  const warnings: string[] = [];
  const src = (raw ?? {}) as Record<string, unknown>;
  const team = typeof src.id === "string" ? src.id : typeof src.team === "string" ? src.team : "imported";

  const rawRoles = Array.isArray(src.roles) ? src.roles : [];
  const roles = rawRoles.map((r0: Record<string, unknown>, i: number) => {
    const kindRaw = typeof r0.kind === "string" ? r0.kind.toLowerCase() : "specialist";
    let kind: RoleKind = "specialist";
    if (kindRaw === "optional_peer") warnings.push(`roles[${i}].kind "optional_peer" 按 specialist 导入`);
    else if (ORCHESTRATOR_KINDS.has(kindRaw)) kind = "orchestrator";
    else if (REVIEWER_KINDS.has(kindRaw)) kind = "reviewer";
    else if (kindRaw !== "specialist") warnings.push(`roles[${i}].kind "${r0.kind}" 未识别，按 specialist 导入`);
    // 社区格式用 null 表示「无值」（如根角色 reports_to: null）→ 清洗为缺省
    const clean = Object.fromEntries(Object.entries(r0).filter(([, v]) => v !== null));
    return RoleSchema.parse({
      ...clean,
      kind,
      id: typeof r0.id === "string" ? r0.id : `role_${i}`,
      name: typeof r0.name === "string" ? r0.name : (typeof r0.id === "string" ? r0.id : `role_${i}`),
      engine: r0.engine ?? { type: "cli", adapter: "mock" },
      profile: typeof r0.profile === "string" ? r0.profile : "profiles/导入.md",
      guards: r0.guards ?? { can_initiate_mention: kind === "orchestrator" },
    });
  });

  // 恰好一个总管：没有就合成（社区语义 = 导入方 agent 自任总管），多个保留首个
  let orchestrators = roles.filter((r) => r.kind === "orchestrator");
  if (orchestrators.length === 0) {
    roles.push(
      RoleSchema.parse({
        id: "chief",
        name: "总管（导入）",
        kind: "orchestrator",
        engine: { type: "cli", adapter: "mock" },
        profile: "profiles/导入.md",
        guards: { can_initiate_mention: true },
      }),
    );
    warnings.push("图中无 orchestrator（社区语义：导入 agent 自任总管）→ 已合成「总管（导入）」蜂房");
    orchestrators = [roles[roles.length - 1]];
  } else if (orchestrators.length > 1) {
    for (const extra of orchestrators.slice(1)) {
      extra.kind = "specialist";
      extra.guards = { can_initiate_mention: false };
      warnings.push(`多个 orchestrator：${extra.id} 降级为 specialist`);
    }
  }
  const chiefId = orchestrators[0].id;

  // handoffs 归一：兼容 from_role_id/to_role_id（社区）与 from/to（Hive）
  const rawHandoffs = Array.isArray(src.handoffs) ? src.handoffs : [];
  let handoffs = rawHandoffs.map((h0: Record<string, unknown>) => {
    const from = h0.from ?? h0.from_role_id;
    const to = h0.to ?? h0.to_role_id;
    return HandoffRuleSchema.parse({ from, to, when: h0.when ?? "导入" });
  });

  // 派单边缺失时从 reports_to 树合成：每只非总管蜂，由其 manager（或总管）派给它
  if (handoffs.length === 0) {
    const ids = new Set(roles.map((r) => r.id));
    for (const r of roles) {
      if (r.id === chiefId || r.kind === "orchestrator") continue;
      const mgr =
        typeof r.reports_to === "string" && ids.has(r.reports_to) && r.reports_to !== r.id ? r.reports_to : chiefId;
      handoffs.push({ from: mgr, to: r.id, when: "agent-org-chart reports_to 树导入" });
    }
    warnings.push(`无 handoffs → 已从 reports_to 树合成 ${handoffs.length} 条派单边`);
  }

  // channels：社区是数组 [{id,name,member_role_ids}]，Hive 是 record
  let channels: Record<string, unknown> | undefined;
  if (Array.isArray(src.channels)) {
    channels = {};
    for (const c of src.channels as Array<Record<string, unknown>>) {
      if (typeof c.id !== "string") continue;
      channels[c.id] = { name: c.name ?? c.id, members: c.member_role_ids ?? [] };
    }
  } else if (src.channels && typeof src.channels === "object") {
    channels = src.channels as Record<string, unknown>;
  }

  const chart = TeamChartSchema.parse({
    ...src,
    schema_version: 1,
    team,
    roles,
    handoffs,
    ...(channels ? { channels } : {}),
  });
  if (src.schema_version !== 1) warnings.push(`schema_version "${src.schema_version}" 非 1，已按 v1 导入`);
  return { chart, warnings };
}
