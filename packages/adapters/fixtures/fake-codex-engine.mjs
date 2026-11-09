#!/usr/bin/env node
/**
 * 假 codex 引擎：模拟 `codex exec --json -` 的 JSONL 输出（离线验证桥接全链路用）。
 * stdin 收 prompt；stdout 按行吐 codex_jsonl 事件；最后一个 agent_message 是协议 JSON。
 * prompt 里含「chief」→ 交棒 researcher；reviewer 角色 → 出 PASS。
 */
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const isReviewer = prompt.includes("角色类型：reviewer");
const isChief = prompt.includes("「chief」");

const reply = isReviewer
  ? JSON.stringify({
      say: "独立审核完成",
      verdict: { verdict: "PASS", evidence: "初稿与上游产物一致，结构完整" },
    })
  : JSON.stringify({
      say: `已按指令完成本棒工作（${isChief ? "总管" : "执行体"}）`,
      artifact: { filename: "engine-artifact.md", content: `# 引擎产物\n\n（来自假 codex 引擎，prompt 前 60 字：${prompt.slice(0, 60)}…）` },
      handoff: {
        to: isChief ? "researcher" : "writer",
        note: { reason: "本棒完成", progress: "产物已产出", ask: "继续下一棒" },
      },
    });

process.stdout.write(JSON.stringify({ type: "item.started", item: { item_type: "agent_message", text: "" } }) + "\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { item_type: "agent_message", text: "开始处理…" } }) + "\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { item_type: "agent_message", text: reply } }) + "\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 950, output_tokens: 220 } }) + "\n");
process.exit(0);
