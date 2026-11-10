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
    say({ type: "output", chunk: `拆解「${instruction}」：① 竞品调研 → ② 成稿 → ③ 独立审核` });
    await sleep(60);
    say({
      type: "handoff",
      to: "researcher",
      note: { reason: "任务含调研子项", progress: "拆解完成，三步计划已定", ask: "产出竞品素材清单（要点 ≥ 5 条）" },
    });
    say({ type: "usage", ...usage });
    process.exit(0);
  }
  if (botId === "researcher") {
    say({ type: "output", chunk: "检索竞品公开资料（3 个来源）…" });
    await sleep(60);
    say({ type: "output", chunk: "整理素材要点 5 条。" });
    const p = artifact("素材", "竞品素材清单", [
      "- 要点 1：竞品定位与目标用户",
      "- 要点 2：核心功能对比",
      "- 要点 3：定价策略",
      "- 要点 4：分发渠道",
      "- 要点 5：差异化机会",
    ].join("\n"));
    await sleep(60);
    say({ type: "artifact", path: p, kind: "materials" });
    say({
      type: "handoff",
      to: "writer",
      note: { reason: "素材产出完成，进入成稿", progress: "素材 v1 已产出（5 条要点）", ask: "基于素材写研究简报初稿" },
    });
    say({ type: "usage", ...usage });
    process.exit(0);
  }
  if (botId === "writer") {
    say({ type: "output", chunk: "基于素材起草研究简报…" });
    await sleep(60);
    say({ type: "output", chunk: "初稿完成。" });
    const p = artifact("初稿", "研究简报（初稿）", "## 摘要\n\n本简报基于研究员产出的 5 条素材要点整理，覆盖定位、功能、定价、渠道与差异化机会。\n\n## 正文\n\n（初稿正文略，约 600 字）\n");
    await sleep(60);
    say({ type: "artifact", path: p, kind: "draft" });
    say({
      type: "handoff",
      to: "reviewer",
      note: { reason: "初稿完成，按治理规则送独立审核", progress: "初稿 v1 已产出", ask: "只出 PASS / BLOCK(带证据) / HOLD，不要替我改稿" },
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
    const draft = (inputArtifacts ?? []).find((a) => a.path && existsSync(a.path) && a.path.includes("writer"));
    if (!draft) {
      say({ type: "verdict", verdict: "BLOCK", evidence: "未找到写手初稿产物，无法审核" });
      say({ type: "usage", ...usage });
      process.exit(0);
    }
    const content = readFileSync(draft.path, "utf8");
    const words = content.replace(/\s/g, "").length;
    say({ type: "verdict", verdict: "PASS", evidence: `初稿存在且完整（${words} 字），素材要点均已覆盖` });
    say({ type: "usage", ...usage });
    process.exit(0);
  }
  process.stderr.write(`未知角色 botId=${botId} role=${role}\n`);
  process.exit(3);
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
