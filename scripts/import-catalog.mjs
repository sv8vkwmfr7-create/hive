#!/usr/bin/env node
/**
 * 社区目录批量导入：serenakeyitan/agent-org-chart 的全部 chart.json
 * → 一键导入为 Hive teams/<id>.json（无审核员的图自动补独立审核舱）。
 * 用法：node scripts/import-catalog.mjs   （需要网络；重复运行幂等覆盖）
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { importAgentOrgChart, validateChart } from "../packages/shared/dist/index.js";

const hiveRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "serenakeyitan/agent-org-chart";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;

async function jfetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

const tree = await jfetch(TREE_API);
const paths = tree.tree
  .filter((x) => /^charts\/[^/]+\/chart\.json$/.test(x.path))
  .map((x) => x.path);
console.log(`社区目录 chart 总数：${paths.length}`);

let ok = 0,
  skipped = [];
for (const p of paths) {
  const id = p.split("/")[1];
  let raw;
  try {
    raw = await jfetch(`${RAW}/${p}`);
  } catch (e) {
    skipped.push(`${id}（下载失败：${e.message}）`);
    continue;
  }
  const { chart, warnings } = importAgentOrgChart(raw);
  if (!chart.roles.some((r) => r.kind === "reviewer")) {
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
  }
  const errs = validateChart(chart);
  if (errs.length) {
    skipped.push(`${id}（导入后不合法：${errs[0]}）`);
    continue;
  }
  const out = join(hiveRoot, "teams", `${chart.team}.json`);
  writeFileSync(out, JSON.stringify(chart, null, 2) + "\n", "utf8");
  ok++;
  console.log(`✅ ${chart.team}（${chart.roles.length} 蜂房，派单 ${chart.handoffs.length} 条）`);
  for (const w of warnings.slice(0, 2)) console.log(`   ⚠️ ${w}`);
}
console.log(`\n完成：导入 ${ok} 套${skipped.length ? `，跳过 ${skipped.length} 套：${skipped.join("；")}` : ""}`);
console.log("全部模板默认 mock 引擎——在架构图上换 brain（engine.adapter）即跑真引擎。");
