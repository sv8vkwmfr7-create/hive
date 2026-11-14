#!/usr/bin/env node
/**
 * 蜂巢事件流查询 CLI（CEO 审计入口）：一切皆事件的回放面。
 * 用法：
 *   node scripts/hive-replay.mjs --list                     列出全部任务（状态/花费/事件数）
 *   node scripts/hive-replay.mjs <taskId>                   回放某单：时间线 + 账单 + 产物
 *   node scripts/hive-replay.mjs <taskId> --json            机器可读输出
 * 可选：DATA_DIR=<dataDir>（默认扫 hive/data/ 最新目录；--list 模式扫全部）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { replayTask } from "../packages/kernel/dist/index.js";
import { EventStore } from "../packages/kernel/dist/index.js";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(scriptRoot, "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const jsonMode = args.includes("--json");
const wantList = args.includes("--list");
const taskId = args.find((a) => !a.startsWith("--"));

const dataRoot = process.env.DATA_DIR ? join(hiveRoot, process.env.DATA_DIR) : join(hiveRoot, "data");
if (!existsSync(dataRoot)) {
  console.error("尚无任务数据（data/ 目录不存在）——先跑一个任务。");
  process.exit(1);
}

const dirs = readdirSync(dataRoot).filter((d) => d.startsWith("real-loop-") || d.startsWith("hive-chat-") || d.startsWith("board-demo-") || d.startsWith("pwa-demo-")).sort();

function openStore(dataDir) {
  if (!existsSync(join(dataDir, "index.db"))) return null;
  return new EventStore(dataDir);
}

function fmtTask(rp) {
  const created = rp.timeline.find((t) => t.kind === "task.created");
  const title = (created?.payload)?.title ?? "";
  const budget = (created?.payload)?.budgetUsd;
  const last = [...rp.timeline].reverse().find((t) => t.kind === "task.status_changed");
  const status = (last?.payload)?.to ?? "running";
  const glyph = status === "ok" ? "✅" : status === "failed" ? "⛔" : "🔄";
  const source = (created?.payload)?.source ?? "";
  return { taskId: rp.taskId, title, status, glyph, spend: rp.receipt.totalUsd, budget, source, events: rp.eventCount };
}

// ---- 列表模式：扫全部数据目录汇总 ----
if (wantList || !taskId) {
  const rows = [];
  for (const d of dirs) {
    const store = openStore(join(dataRoot, d));
    if (!store) continue;
    const ids = [...new Set(store.allEvents().map((e) => e.taskId))];
    for (const id of ids) {
      const rp = replayTask(store, id);
      if (rp.timeline.length) rows.push({ dir: d, ...fmtTask(rp) });
    }
    store.close?.();
  }
  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  }
  if (!rows.length) {
    console.log("尚无任务记录。");
    process.exit(0);
  }
  console.log("任务清单（全部数据目录汇总，新任务在后）：\n");
  for (const r of rows) {
    console.log(`${r.glyph} #${r.taskId}「${r.title}」 ${r.status} · 花费 $${r.spend.toFixed(4)}${r.budget != null ? `/$${r.budget}` : ""} · ${r.events} 事件 · 来源 ${r.source}`);
  }
  const total = rows.reduce((a, r) => a + r.spend, 0);
  console.log(`\n合计 ${rows.length} 单 · 总花费 $${total.toFixed(4)}`);
  process.exit(0);
}

// ---- 单任务回放：找包含该 taskId 的最新数据目录 ----
let found = null;
for (const d of [...dirs].reverse()) {
  const store = openStore(join(dataRoot, d));
  if (!store) continue;
  const evs = store.replayTaskEvents(taskId);
  if (evs.length) {
    found = { store, dir: d };
    break;
  }
  store.close?.();
}
if (!found) {
  console.error(`任务 #${taskId} 不存在于任何数据目录。`);
  process.exit(1);
}

const rp = replayTask(found.store, taskId);
if (jsonMode) {
  console.log(JSON.stringify(rp, null, 2));
  process.exit(0);
}

const created = rp.timeline.find((t) => t.kind === "task.created");
const info = (created?.payload) ?? {};
console.log(`\n🐝 蜂巢 · 任务 #${taskId}「${info.title ?? ""}」回放（数据目录 ${found.dir}）`);
console.log(`一句话：${info.brief ?? ""}`);
console.log(`预算：$${info.budgetUsd ?? "∞"} · 来源：${info.source ?? "?"}\n`);

console.log("── 时间线 ──────────────────────────────");
for (const t of rp.timeline) {
  const brief =
    t.kind === "handoff.created"
      ? `${t.payload.from} → ${t.payload.to}（${String(t.payload.note?.ask ?? "").slice(0, 40)}）`
      : t.kind === "cost.recorded"
        ? `${t.payload.botId} 花费 $${t.payload.usd}`
        : t.kind === "artifact.produced"
          ? t.payload.path.split(/[\\/]/).at(-1)
          : t.kind === "review.verdict"
            ? `${t.payload.verdict}：${String(t.payload.evidence ?? "").slice(0, 50)}`
            : t.kind === "task.status_changed"
              ? t.payload.reason
              : t.kind === "bot.output"
                ? String(t.payload.chunk).slice(0, 60)
                : t.kind === "error.reported"
                  ? String(t.payload.message).slice(0, 60)
                  : "";
  console.log(`${String(t.seq).padStart(3)}  ${t.glyph ?? "  "}  ${t.kind.padEnd(20)} ${t.actor.padEnd(10)} ${brief}`);
}

console.log("\n── 账单 ────────────────────────────────");
for (const c of rp.receipt.entries) {
  console.log(`  ${c.botId}（${c.engine}${c.model ? "/" + c.model : ""}）：${c.tokensIn ?? 0} 入 / ${c.tokensOut ?? 0} 出 → $${c.usd}`);
}
console.log(`  合计 $${rp.receipt.totalUsd.toFixed(4)}（小票 ${join(hiveRoot, "data", found.dir, "ledger", `task-${taskId}.receipt.json`)}）`);

// 档位建议（差异化③："这活 T1 就够，省 80%"）：任务里有 T0 贵档蜂时，同 tokens 按 T1 档牌价重算对比。
// 只向下建议一档（T0→T1），不把 T2 小模型推去干 T1 的活——机械比牌价会牺牲质量。
try {
  const { loadAdapter } = await import("../packages/adapters/dist/index.js");
  const ad = join(hiveRoot, "packages", "adapters", "adapters");
  const contracts = readdirSync(ad)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return loadAdapter(join(ad, f));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const tierOf = Object.fromEntries(contracts.map((c) => [c.adapter, c.tier]));
  const t1Baseline = contracts
    .filter((c) => c.kind === "api" && c.pricing && c.tier === "T1" && c.pricing.input_per_mtok + c.pricing.output_per_mtok > 0)
    .sort((a, b) => a.pricing.input_per_mtok + a.pricing.output_per_mtok - (b.pricing.input_per_mtok + b.pricing.output_per_mtok))[0];
  const real = rp.receipt.entries.filter((e) => e.engine !== "mock" && (e.tokensIn ?? 0) > 0);
  const hasT0 = real.some((e) => (tierOf[e.engine] ?? "T1") === "T0");
  if (t1Baseline && hasT0) {
    const alt = real.reduce(
      (sum, e) => sum + ((e.tokensIn ?? 0) / 1e6) * t1Baseline.pricing.input_per_mtok + ((e.tokensOut ?? 0) / 1e6) * t1Baseline.pricing.output_per_mtok,
      0,
    );
    const cur = real.reduce((sum, e) => sum + e.usd, 0);
    if (cur > 0 && alt < cur * 0.9) {
      console.log(
        `  💡 档位建议：本单含 T0 档蜂——tokens 若走 ${t1Baseline.adapter}（T1 档）约 $${alt.toFixed(4)}，可省 ${Math.round((1 - alt / cur) * 100)}%（复杂任务可保留总管在 T0）`,
      );
    }
  }
} catch {
  /* 建议生成失败不影响回放 */
}

const verdict = rp.timeline.find((t) => t.kind === "review.verdict");
console.log(`\n── 结论：${verdict ? (verdict.payload).verdict : "（无审核结论）"} · 事件 ${rp.eventCount} 条，全部可回放审计 ✅`);
found.store.close?.();
