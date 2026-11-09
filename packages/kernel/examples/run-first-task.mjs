#!/usr/bin/env node
/**
 * 第一个本地任务闭环 demo：
 * 发一句话（task.created）→ mock 团队 chief→researcher→writer→reviewer 全自动跑完
 * → ✅ 交付 + 账单落盘；打印可回放的事件时间线。
 * 运行：pnpm build && node examples/run-first-task.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel, replayTask } from "../dist/index.js";

const kernelRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const hiveRoot = join(kernelRoot, "..");
const chart = JSON.parse(readFileSync(join(kernelRoot, "..", "..", "teams", "mock-team.json"), "utf8"));

const dataDir = join(kernelRoot, "data", `demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const kernel = new HiveKernel({ dataDir, chart });
const taskId = kernel.createTask({
  title: "竞品简报",
  brief: "调研 3 个竞品的定位与定价，产出一份研究简报",
  budgetUsd: 3,
  source: "local-demo（模拟：用户在聊天工具里发的一句话）",
});

console.log(`\n🐝 蜂巢 · 任务 #${taskId}「竞品简报」预算 $3\n`);
const res = await kernel.runTask(taskId);

const rp = replayTask(kernel.store, taskId);
console.log("── 事件时间线（可回放审计）────────────────────────");
for (const t of rp.timeline) {
  const brief =
    t.kind === "handoff.created"
      ? `${t.payload.from} → ${t.payload.to}（${t.payload.note.ask}）`
      : t.kind === "cost.recorded"
        ? `${t.payload.botId} 花费 $${t.payload.usd}`
        : t.kind === "artifact.produced"
          ? t.payload.path.split(/[\\/]/).at(-1)
          : t.kind === "review.verdict"
            ? `${t.payload.verdict}：${t.payload.evidence ?? ""}`
            : t.kind === "task.status_changed"
              ? t.payload.reason
              : t.kind === "bot.output"
                ? String(t.payload.chunk).slice(0, 42)
                : "";
  console.log(`${String(t.seq).padStart(3)}  ${t.glyph ?? "  "}  ${t.kind.padEnd(20)} ${t.actor.padEnd(10)} ${brief}`);
}

console.log("\n── 账单（工资单，已落盘）──────────────────────────");
console.log(JSON.stringify(rp.receipt, null, 2));

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(join(dataDir, "index.db"));
const rows = db.prepare("SELECT COUNT(*) AS c FROM events").get();
console.log(`\n── 溯源完整性 ─────────────────────────────────────`);
console.log(`JSONL 事件 ${rp.eventCount} 行 · SQLite 索引 ${rows.c} 行 · 状态：${res.status}`);
if (res.status !== "ok") {
  console.log(`原因：${res.reason}`);
  process.exitCode = 1;
}
