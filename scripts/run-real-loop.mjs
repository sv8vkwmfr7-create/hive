#!/usr/bin/env node
/**
 * 真引擎 3-bot 完整闭环 runner（北极星验证，minus 聊天传输段）：
 * 发一句话（task.created）→ 真引擎团队 chief→researcher→writer→reviewer 全自动跑完
 * → ✅/⛔ 交付 + 账单落盘；打印可回放的事件时间线。
 * 凭据代理默认开启：worker 只见 127.0.0.1 代理地址，真 key 不出内核进程。
 * 运行：node --env-file=.env scripts/run-real-loop.mjs [HIVE_TEAM=real-team-ds]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel, replayTask } from "../packages/kernel/dist/index.js";
import { createAdapterResolver, startCredentialProxy } from "../packages/adapters/dist/index.js";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(scriptRoot, "..");
const teamName = process.env.HIVE_TEAM ?? "real-team-ds";
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${teamName}.json`), "utf8"));

const dataDir = join(hiveRoot, "data", `real-loop-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const adaptersDir = join(hiveRoot, "packages", "adapters", "adapters");
const proxy = await startCredentialProxy({ adaptersDir, env: process.env });
const workers = createAdapterResolver({ adaptersDir, proxyUrl: proxy.url, proxySecret: proxy.secret });
// 共享大脑：设 HIVE_VAULT=<vault 目录> → 任务 PASS 后交付摘要自动落库，后续任务接活先查库
const vaultDir = process.env.HIVE_VAULT ?? undefined;
const kernel = new HiveKernel({ dataDir, chart, workers, vaultDir });

const taskId = kernel.createTask({
  title: "竞品简报",
  brief: process.env.HIVE_BRIEF ?? "调研 AI 编排工具赛道上 3 个有代表性的竞品（如 CrewAI、LangGraph、botmux 类产品）的定位与定价，产出一份不超过 800 字的研究简报",
  budgetUsd: Number(process.env.HIVE_BUDGET_USD ?? 3),
  source: "local-real-loop（模拟：用户在聊天工具里发的一句话）",
});

console.log(`\n🐝 蜂巢 · 真引擎闭环 · 任务 #${taskId}「竞品简报」团队=${teamName} 预算 $3（凭据代理 ${proxy.url}）\n`);
const t0 = Date.now();
try {
  const res = await kernel.runTask(taskId);
  const secs = Math.round((Date.now() - t0) / 1000);

  const rp = replayTask(kernel.store, taskId);
  console.log("── 事件时间线（可回放审计）────────────────────────");
  for (const t of rp.timeline) {
    const brief =
      t.kind === "handoff.created"
        ? `${t.payload.from} → ${t.payload.to}（${String(t.payload.note?.ask ?? "").slice(0, 30)}…）`
        : t.kind === "cost.recorded"
          ? `${t.payload.botId} 花费 $${t.payload.usd}`
          : t.kind === "artifact.produced"
            ? t.payload.path.split(/[\\/]/).at(-1)
            : t.kind === "review.verdict"
              ? `${t.payload.verdict}：${String(t.payload.evidence ?? "").slice(0, 40)}`
              : t.kind === "task.status_changed"
                ? t.payload.reason
                : t.kind === "bot.output"
                  ? String(t.payload.chunk).slice(0, 42)
                  : "";
    console.log(`${String(t.seq).padStart(3)}  ${t.glyph ?? "  "}  ${t.kind.padEnd(20)} ${t.actor.padEnd(10)} ${brief}`);
  }

  console.log("\n── 账单（工资单，已落盘）──────────────────────────");
  console.log(JSON.stringify(rp.receipt, null, 2));

  console.log(`\n── 溯源完整性 ─────────────────────────────────────`);
  console.log(`JSONL 事件 ${rp.eventCount} 行 · 状态：${res.status} · 全程 ${secs}s`);
  if (res.status !== "ok") {
    console.log(`原因：${res.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`北极星（minus 聊天传输段）✅：一句话 → 3 bot 真引擎全自动交付 → 账单落盘，用时 ${secs}s（上限 1800s）`);
  }
} finally {
  await proxy.close();
}
