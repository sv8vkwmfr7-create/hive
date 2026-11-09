import { z } from "zod";
import { readFileSync } from "node:fs";
import { getPath } from "./jsonPath.js";

const JsonPath = z.string().min(2).refine((s) => s.startsWith("$"), "usage_parse 路径必须以 $ 开头");

/**
 * 引擎适配器契约 schema（交接文档 §4 的 adapters/<engine>.json v1）。
 * 引擎 API 变动只改契约文件，桥代码不动——适配器隔离原则。
 */
export const AdapterContract = z
  .object({
    adapter: z.string().min(1),
    kind: z.enum(["cli", "api", "local"]),
    mode: z.enum(["claude_json", "codex_jsonl", "openai_chat"]),
    contract_version: z.literal(1),
    /** cli 系：spawn 命令行（{prompt} 占位或 stdin_prompt=true 时经 stdin 送 prompt） */
    spawn: z.string().min(1).optional(),
    stdin_prompt: z.boolean().optional(),
    /** api 系：OpenAI 兼容 chat.completions */
    base_url: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    env_key: z.string().min(1).optional(),
    /** 解析规则：scan 存在时 tokens/usd 路径相对 scan 结果求值（不带 $），否则相对整个文档（带 $） */
    usage_parse: z
      .object({
        final_text: JsonPath.optional(),
        scan: JsonPath.optional(),
        usd: z.string().min(1).optional(),
        tokens_in: z.string().min(1).optional(),
        tokens_out: z.string().min(1).optional(),
      })
      .optional(),
    /** codex_jsonl：从事件行里筛出最终消息（where 路径取值 == equals → 取 text 路径） */
    final_items: z
      .object({ where: JsonPath, equals: z.string(), text: JsonPath })
      .optional(),
    pricing: z
      .object({
        input_per_mtok: z.number().nonnegative(),
        output_per_mtok: z.number().nonnegative(),
      })
      .optional(),
    on_unparseable: z.enum(["fail", "text_output"]).default("fail"),
    timeout_ms: z.number().int().positive().default(300000),
    caps: z.record(z.string(), z.unknown()).default({}),
    tier: z.string().optional(),
    notes: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.kind === "cli" && !c.spawn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spawn"], message: "cli 引擎必须定义 spawn 命令" });
    }
    if (c.kind === "api") {
      for (const [field, label] of [
        ["base_url", "base_url"],
        ["model", "model"],
        ["env_key", "env_key"],
      ] as const) {
        if (!c[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `api 引擎必须定义 ${label}` });
      }
    }
    if (c.mode === "codex_jsonl" && !c.final_items) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["final_items"], message: "codex_jsonl 模式必须定义 final_items" });
    }
  });
export type AdapterContract = z.infer<typeof AdapterContract>;

export class ContractError extends Error {}

/** 从文件加载并校验契约（启动即验证，坏的契约不进内核） */
export function loadAdapter(file: string): AdapterContract {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ContractError(`契约文件不可读：${file}（${e instanceof Error ? e.message : e}）`);
  }
  const parsed = AdapterContract.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ContractError(`契约不合法：${file}（${detail}）`);
  }
  return parsed.data;
}

/** 计费：优先契约 usd 路径 → pricing 牌价估算 → 0（订阅额度制，tokens 如实记账） */
export function computeUsd(
  contract: AdapterContract,
  source: unknown,
  tokensIn?: number,
  tokensOut?: number,
): number {
  const up = contract.usage_parse;
  if (up?.usd) {
    const v = getPath(source, up.usd);
    if (typeof v === "number" && v >= 0) return v;
  }
  if (contract.pricing && tokensIn != null && tokensOut != null) {
    // 不在此处舍入：账本保留全精度，展示层（小票/看板）自行 toFixed
    return (tokensIn / 1e6) * contract.pricing.input_per_mtok + (tokensOut / 1e6) * contract.pricing.output_per_mtok;
  }
  return 0;
}
