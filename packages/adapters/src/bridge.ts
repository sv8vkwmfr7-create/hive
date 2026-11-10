import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeUsd } from "./contract.js";
import type { AdapterContract } from "./contract.js";
import { getPath } from "./jsonPath.js";
import { buildPrompt, clip } from "./prompt.js";
import type { TaskPack } from "./prompt.js";

/** worker → kernel 的协议消息（与 @hive/kernel BotMsg 同构，这里独立声明避免运行时依赖） */
export type ProtocolMsg =
  | { type: "output"; chunk: string }
  | { type: "handoff"; to: string; note: unknown }
  | { type: "artifact"; path: string; kind?: string }
  | { type: "usage"; tokensIn?: number; tokensOut?: number; usd: number; model?: string }
  | { type: "approval"; action: string; risk?: string }
  | { type: "verdict"; verdict: "PASS" | "BLOCK" | "HOLD"; evidence?: string; reason?: string };

export class BridgeError extends Error {}

const say = (msg: ProtocolMsg): void => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

export interface BridgeResult {
  exitCode: number;
}

/**
 * 桥接主流程：任务包 + 契约 → 调引擎 → 解析 → 按 kernel 行协议下发。
 * 任何失败走 stderr + 非零退出码——内核会如实把任务标 ⛔，绝不谎报成功。
 */
export async function runBridge(pack: TaskPack, contract: AdapterContract): Promise<BridgeResult> {
  const prompt = buildPrompt(pack, contract.adapter);

  let finalText: string;
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  let usageSource: unknown;

  if (contract.mode === "openai_chat") {
    const r = await callOpenAiChat(contract, prompt);
    finalText = r.finalText;
    tokensIn = r.tokensIn;
    tokensOut = r.tokensOut;
    usageSource = r.usageSource;
    if (finalText) say({ type: "output", chunk: clip(finalText) });
  } else {
    const r = await callCli(contract, prompt);
    finalText = r.finalText;
    tokensIn = r.tokensIn;
    tokensOut = r.tokensOut;
    usageSource = r.usageSource;
  }

  const usd = computeUsd(contract, usageSource, tokensIn, tokensOut);
  say({
    type: "usage",
    tokensIn,
    tokensOut,
    usd,
    model: contract.model ?? contract.adapter,
  });

  // 引擎的最终文本应是一个协议 JSON；解析失败按契约处理（fail=诚实退出，text_output=纯文本交付）
  const protocol = extractJson(finalText);
  if (!protocol) {
    if (contract.on_unparseable === "text_output") {
      say({ type: "output", chunk: clip(finalText || "（引擎无输出）") });
      return { exitCode: 0 };
    }
    process.stderr.write(`引擎回复不是协议 JSON（前 300 字）：${finalText.slice(0, 300)}\n`);
    return { exitCode: 3 };
  }

  emitProtocol(pack, protocol);
  return { exitCode: 0 };
}

function emitProtocol(pack: TaskPack, protocol: Record<string, unknown>): void {
  if (typeof protocol.say === "string" && protocol.say) {
    say({ type: "output", chunk: clip(protocol.say) });
  }
  const artifact = protocol.artifact as { filename?: unknown; content?: unknown } | undefined;
  if (artifact && typeof artifact.content === "string" && artifact.content) {
    const name = typeof artifact.filename === "string" && artifact.filename ? artifact.filename : `${pack.botId}-产出.md`;
    mkdirSync(pack.artifactDir, { recursive: true });
    const path = join(pack.artifactDir, name);
    writeFileSync(path, artifact.content, "utf8");
    say({ type: "artifact", path });
  }
  const handoff = protocol.handoff as { to?: unknown; note?: unknown } | undefined;
  if (handoff && typeof handoff.to === "string" && handoff.to) {
    say({ type: "handoff", to: handoff.to, note: handoff.note });
  }
  const approval = protocol.approval as { action?: unknown; risk?: unknown } | undefined;
  if (approval && typeof approval.action === "string" && approval.action) {
    say({
      type: "approval",
      action: approval.action,
      risk: approval.risk === "low" || approval.risk === "medium" ? approval.risk : "high",
    });
  }
  const verdict = protocol.verdict as { verdict?: unknown; evidence?: unknown; reason?: unknown } | undefined;
  if (verdict && typeof verdict.verdict === "string") {
    say({
      type: "verdict",
      verdict: verdict.verdict as "PASS" | "BLOCK" | "HOLD",
      evidence: typeof verdict.evidence === "string" ? verdict.evidence : undefined,
      reason: typeof verdict.reason === "string" ? verdict.reason : undefined,
    });
  }
}

/** 从引擎文本里抠协议 JSON：优先代码块，其次首尾大括号 */
export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(candidate.slice(start, end + 1));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface EngineResult {
  finalText: string;
  tokensIn?: number;
  tokensOut?: number;
  usageSource: unknown;
}

/** CLI 系引擎：spawn 契约命令（stdin 送 prompt），按 mode 解析 stdout */
function callCli(contract: AdapterContract, prompt: string): Promise<EngineResult> {
  return new Promise((resolve) => {
    const child = spawn(contract.spawn!, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, contract.timeout_ms);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        process.stderr.write(`引擎超时（>${contract.timeout_ms}ms）被内核侧终止\n`);
        process.exit(4);
      }
      if (code !== 0) {
        process.stderr.write(`引擎退出码 ${code}：${stderr.slice(-500)}\n`);
        process.exit(1);
      }
      try {
        resolve(contract.mode === "claude_json" ? parseClaudeJson(contract, stdout) : parseCodexJsonl(contract, stdout));
      } catch (e) {
        process.stderr.write(`解析引擎输出失败：${e instanceof Error ? e.message : e}\nstdout 尾部：${stdout.slice(-500)}\n`);
        process.exit(5);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** claude -p --output-format json：单 JSON 文档 */
function parseClaudeJson(contract: AdapterContract, stdout: string): EngineResult {
  const doc = JSON.parse(stdout) as unknown;
  const up = contract.usage_parse ?? {};
  const finalText = String(getPath(doc, up.final_text ?? "$.result") ?? "");
  const num = (p?: string) => {
    if (!p) return undefined;
    const v = getPath(doc, p);
    return typeof v === "number" ? v : undefined;
  };
  return {
    finalText,
    tokensIn: num(up.tokens_in),
    tokensOut: num(up.tokens_out),
    usageSource: doc,
  };
}

/** codex exec --json：JSONL 事件流；agent_message 条目即输出，usage 从事件行扫描 */
function parseCodexJsonl(contract: AdapterContract, stdout: string): EngineResult {
  const fi = contract.final_items!;
  const texts: string[] = [];
  let usageRaw: unknown;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // 非 JSON 行（日志噪音）跳过
    }
    if (getPath(evt, fi.where) === fi.equals) {
      const t = getPath(evt, fi.text);
      if (typeof t === "string" && t) texts.push(t);
    }
    const scan = contract.usage_parse?.scan;
    if (scan) {
      const u = getPath(evt, scan);
      if (u && typeof u === "object") usageRaw = u;
    }
  }
  const rel = (p?: string) => {
    if (!p || usageRaw == null) return undefined;
    const v = getPath(usageRaw, p);
    return typeof v === "number" ? v : undefined;
  };
  return {
    finalText: texts.at(-1) ?? "",
    tokensIn: rel(contract.usage_parse?.tokens_in),
    tokensOut: rel(contract.usage_parse?.tokens_out),
    usageSource: usageRaw,
  };
}

/** OpenAI 兼容 chat.completions（凭据经内核环境注入，桥接进程拿到即用、不落盘；本地引擎可免 key） */
async function callOpenAiChat(contract: AdapterContract, prompt: string): Promise<EngineResult> {
  const key = contract.env_key ? (process.env[contract.env_key] ?? "") : "local";
  if (!key) {
    process.stderr.write(`缺少环境变量 ${contract.env_key}（凭据由内核注入，见 docs/引擎清单.md）\n`);
    process.exit(2);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), contract.timeout_ms);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (contract.env_key) headers.authorization = `Bearer ${key}`;
    const res = await fetch(`${contract.base_url!.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: contract.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      process.stderr.write(`API ${res.status}：${(await res.text()).slice(0, 500)}\n`);
      process.exit(1);
    }
    const doc = (await res.json()) as unknown;
    const up = contract.usage_parse ?? {};
    const finalText = String(getPath(doc, up.final_text ?? "$.choices[0].message.content") ?? "");
    const num = (p?: string) => {
      if (!p) return undefined;
      const v = getPath(doc, p);
      return typeof v === "number" ? v : undefined;
    };
    return { finalText, tokensIn: num(up.tokens_in), tokensOut: num(up.tokens_out), usageSource: doc };
  } catch (e) {
    process.stderr.write(`API 调用失败：${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}
