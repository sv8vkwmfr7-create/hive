#!/usr/bin/env node
/**
 * agent-org-chart chart.json → Hive teams/<id>.json 一键导入。
 * 社区图（平台无关、无引擎）默认 mock 引擎导入；导入后点蜂房换脑即可跑真引擎。
 *
 * 用法：node scripts/import-team.mjs <chart.json> [--with-reviewer]
 *   --with-reviewer  图里没有审核员时追加一个独立审核舱（mock），所有专业岗产出后送审
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { importAgentOrgChart, validateChart } from "../packages/shared/dist/index.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const withReviewer = args.includes("--with-reviewer");
const input = args.find((a) => !a.startsWith("--"));
if (!input) {
  console.error("用法：node scripts/import-team.mjs <chart.json> [--with-reviewer]");
  process.exit(1);
}
if (!existsSync(input)) {
  console.error(`文件不存在：${input}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(input, "utf8"));
const { chart, warnings } = importAgentOrgChart(raw);

if (withReviewer && !chart.roles.some((r) => r.kind === "reviewer")) {
  chart.roles.push({
    id: "reviewer",
    name: "审核员（导入补充）",
    kind: "reviewer",
    engine: { type: "cli", adapter: "mock" },
    profile: "profiles/导入.md",
    guards: { can_initiate_mention: false },
  });
  for (const r of chart.roles) {
    if (r.kind === "specialist") {
      chart.handoffs.push({ from: r.id, to: "reviewer", when: "产出完成后送独立审核（导入补充）" });
    }
  }
  warnings.push("已追加独立审核舱 reviewer（--with-reviewer），所有专业岗产出后送审");
}

const errs = validateChart(chart);
if (errs.length) {
  console.error("导入后的图不合法：\n- " + errs.join("\n- "));
  process.exit(1);
}

const hiveRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(hiveRoot, "teams", `${chart.team}.json`);
writeFileSync(out, JSON.stringify(chart, null, 2) + "\n", "utf8");
console.log(`✅ 导入 → ${out}`);
for (const w of warnings) console.log("  ⚠️ " + w);
console.log("角色:", chart.roles.map((r) => `${r.id}(${r.kind})`).join(", "));
console.log("派单链:", chart.handoffs.map((h) => `${h.from}→${h.to}`).join(", ") || "(无)");
console.log("下一步：把各蜂房的 engine.adapter 换成可用引擎（换脑 = 换 engine 字段），或直接 HIVE_TEAM 跑 mock 闭环。");
