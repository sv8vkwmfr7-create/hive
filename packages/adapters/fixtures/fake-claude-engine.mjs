#!/usr/bin/env node
/**
 * 假 claude 引擎：模拟 `claude -p --output-format json` 的单 JSON 输出（离线验证 claude_json 模式用）。
 */
import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf8");
const result = JSON.stringify({
  say: "claude_json 模式冒烟成功",
  artifact: { filename: "claude-artifact.md", content: "# claude 产物\n\n内容正文。" },
  handoff: { to: "writer", note: { reason: "本棒完成", progress: "产物已产出", ask: "继续下一棒" } },
});
process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    result,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
  }) + "\n",
);
void prompt;
process.exit(0);
