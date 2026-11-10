#!/usr/bin/env node
/**
 * mock 引擎 worker：Hive 内核引擎协议的参考实现。
 * stdin 收一行 JSON 任务包；stdout 每行吐一个协议消息 JSON；退出码 0 = 成功。
 * 真实引擎适配器（codex/claude-code/deepseek）接入时复用同一协议，内核不改。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { taskId, botId, role, instruction, artifactDir, inputArtifacts } = input;
// 通用派单：目标来自内核下发的派单链（chart 边），任意团队图都能离线跑通
const handoffTarget = (input.handoffs ?? [])[0]?.to;
const USAGE = {
  chief: { tokensIn: 900, tokensOut: 210, usd: 0.05, model: "mock-flagship" },
  researcher: { tokensIn: 1200, tokensOut: 640, usd: 0.2, model: "mock-standard" },
  writer: { tokensIn: 1100, tokensOut: 900, usd: 0.15, model: "mock-standard" },
  reviewer: { tokensIn: 1500, tokensOut: 90, usd: 0.1, model: "mock-standard" },
};
const usage = USAGE[botId] ?? { tokensIn: 1000, tokensOut: 300, usd: 0.12, model: "mock-standard" };

function artifactPath(name) {
  return join(artifactDir, `${botId}-${name}.md`);
}

function artifact(name, title, body) {
  const p = artifactPath(name);
  writeFileSync(p, `# ${title}\n\n> 任务 #${taskId} · bot: ${botId} · 指令：${instruction || "（无）"}\n\n${body}\n`, "utf8");
  return p;
}

async function main() {
  await sleep(60);
  if (role === "orchestrator") {
    say({ type: "output", chunk: `拆解「${instruction}」：① 专业岗产出 → ② 独立审核` });
    await sleep(60);
    if (!handoffTarget) {
      say({ type: "usage", ...usage });
      process.exit(0);
    }
    say({
      type: "handoff",
      to: handoffTarget,
      note: { reason: "任务含专业产出子项", progress: "拆解完成，计划已定", ask: "产出本岗位交付物" },
    });
    say({ type: "usage", ...usage });
    process.exit(0);
  }
  if (botId === "reviewer") {
    // 审批门演示：设 HIVE_MOCK_APPROVAL=<动作名> 时，reviewer 首跑先请求审批（内核挂起等 CEO）；
    // 批准后重跑时任务包 approvals 已含该动作 → 直接出结论。
    const needApproval = process.env.HIVE_MOCK_APPROVAL;
    if (needApproval && !(input.approvals ?? []).includes(needApproval)) {
      say({ type: "output", chunk: `需要审批：${needApproval}（高风险动作，内核挂起等待 CEO）` });
      say({ type: "approval", action: needApproval, risk: "high" });
      say({ type: "usage", ...usage });
      process.exit(0);
    }
    say({ type: "output", chunk: "独立会话审核：只判 PASS / BLOCK / HOLD。" });
    await sleep(60);
    const draft = (inputArtifacts ?? []).find((a) => a.path && existsSync(a.path));
    if (!draft) {
      say({ type: "verdict", verdict: "BLOCK", evidence: "未找到可审核的上游产物，无法审核" });
      say({ type: "usage", ...usage });
      process.exit(0);
    }
    const content = readFileSync(draft.path, "utf8");
    const words = content.replace(/\s/g, "").length;
    say({ type: "verdict", verdict: "PASS", evidence: `产物存在且完整（${words} 字），覆盖任务要求` });
    say({ type: "usage", ...usage });
    process.exit(0);
  }
  // 通用专业岗（任意 botId，含导入团队）：产出 artifact + 按派单链交棒
  say({ type: "output", chunk: `处理指令：${instruction || "（无）"}` });
  const p = artifact("产出", "任务产出", `## 产出\n\n基于指令「${instruction || "（无）"}」的专业产出（mock）。\n`);
  await sleep(60);
  say({ type: "artifact", path: p, kind: "output" });
  if (handoffTarget) {
    say({
      type: "handoff",
      to: handoffTarget,
      note: { reason: "本岗位产出完成", progress: "产出 v1 已交付", ask: "继续派单链的下一棒" },
    });
  }
  say({ type: "usage", ...usage });
  process.exit(0);
}

if (!artifactDir) {
  process.stderr.write("缺少 artifactDir\n");
  process.exit(2);
}
mkdirSync(artifactDir, { recursive: true });
main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exit(1);
});
