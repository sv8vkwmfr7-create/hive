#!/usr/bin/env node
/**
 * 模板市场 v0：给一个 GitHub 链接（或本地路径）一键装团队。
 * 「组织架构图就是新的 Prompt」——任何公开仓库里的 chart.json 都能被装进 teams/ 直接用。
 *
 * 支持：
 *   node scripts/hive-import.mjs <owner>/<repo>[/<子目录>]        # 短格式：试常见文件名 + <目录名>.json
 *   node scripts/hive-import.mjs https://github.com/o/r/blob/main/path/team.json
 *   node scripts/hive-import.mjs https://raw.githubusercontent.com/o/r/main/path/team.json
 *   node scripts/hive-import.mjs ./local-chart.json               # 本地路径（同 import-team.mjs）
 * 选项：--with-reviewer（无审核员时补独立审核舱）  --name <自定义名>  --force（覆盖同名）
 *
 * 退出方式：process.exitCode 而非 process.exit——fetch 的 keep-alive 在 Windows 上
 * 会被硬 exit 撞出 libuv 断言（与 bridgeWorker 修复同族），让事件循环自然排空。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { importAgentOrgChart, validateChart } from "../packages/shared/dist/index.js";

const hiveRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMON_NAMES = ["chart.json", "team.json", "org-chart.json", "hive.json", "team-chart.json"];

/** GitHub 各形态 URL → raw 直链候选（本地路径返回 {local}；不支持形态返回 null） */
function rawCandidates(input) {
  if (existsSync(input)) return { local: input };
  const strip = (u) => u.replace(/\/$/, "");
  if (input.startsWith("https://raw.githubusercontent.com/")) return { urls: [strip(input)] };
  // github.com/o/r/blob/<ref>/<path> → raw 直链；tree/<ref>/<dir> → 目录 + 常见文件名
  const gh = input.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(blob|tree)\/([^/]+)\/(.+)$/);
  if (gh) {
    const [, o, r, kind, ref, path] = gh;
    const base = `https://raw.githubusercontent.com/${o}/${r}/${ref}/${path}`;
    return { urls: kind === "blob" ? [strip(base)] : COMMON_NAMES.map((n) => `${strip(base)}/${n}`) };
  }
  // 短格式 owner/repo（可带子目录）→ 常见文件名 + <目录名>.json（catalog 布局）
  const short = input.match(/^([\w.-]+)\/([\w.-]+)(?:\/(.+))?$/);
  if (short) {
    const [, o, r, sub] = short;
    const base = `https://raw.githubusercontent.com/${o}/${r}/HEAD${sub ? `/${sub.replace(/^\//, "")}` : ""}`;
    const names = [...COMMON_NAMES];
    if (sub) names.unshift(`${sub.replace(/^\//, "").split("/").at(-1)}.json`);
    return { urls: names.map((n) => `${base}/${n}`) };
  }
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "hive-import" } });
  if (!res.ok) return null;
  const text = await res.text();
  try {
    return { url, raw: JSON.parse(text) };
  } catch {
    return null; // 非 JSON（如 404 页面）→ 视为未命中
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const withReviewer = args.includes("--with-reviewer");
  const force = args.includes("--force");
  const nameIdx = args.indexOf("--name");
  const customName = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
  const input = args.find((a) => !a.startsWith("--") && a !== customName);
  if (!input) throw new Error(`用法：node scripts/hive-import.mjs <github-url | owner/repo | 本地路径> [--with-reviewer] [--name <名>] [--force]`);

  let rawJson;
  let source;
  if (existsSync(input)) {
    rawJson = JSON.parse(readFileSync(input, "utf8"));
    source = input;
  } else {
    const cand = rawCandidates(input);
    if (!cand) throw new Error(`无法识别的来源：${input}（本地路径不存在，URL 形态不支持）`);
    if (cand.local) {
      rawJson = JSON.parse(readFileSync(cand.local, "utf8"));
      source = cand.local;
    } else {
      console.error(`正在拉取 ${input} …`);
      let hit = null;
      for (const u of cand.urls) {
        hit = await fetchJson(u);
        if (hit) {
          console.error(`✓ 命中 ${u}`);
          break;
        }
      }
      if (!hit) throw new Error(`这些地址都没拉到合法 chart JSON：\n  ` + cand.urls.join("\n  "));
      rawJson = hit.raw;
      source = hit.url;
    }
  }

  const { chart, warnings } = importAgentOrgChart(rawJson);
  const teamName = customName || chart.team || "imported";

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
  if (errs.length) throw new Error("导入后的图不合法（如实拒绝，不落盘）：\n- " + errs.join("\n- "));

  const out = join(hiveRoot, "teams", `${teamName}.json`);
  if (existsSync(out) && !force) throw new Error(`teams/${teamName}.json 已存在——换名重试：--name <新名>；确认覆盖：--force`);
  chart.team = teamName;
  writeFileSync(out, JSON.stringify(chart, null, 2) + "\n", "utf8");

  console.log(`\n✅ 已装团队「${teamName}」（来源：${source}）→ teams/${teamName}.json`);
  for (const w of warnings) console.log("  ⚠️ " + w);
  console.log("阵容:", chart.roles.map((r) => `${r.id}(${r.kind})`).join(", "));
  console.log("派单链:", chart.handoffs.map((h) => `${h.from}→${h.to}`).join(", ") || "(无)");
  console.log(`\n下一步：`);
  console.log(`  直接用（mock 引擎先跑通）：HIVE_TEAM=${teamName} node --env-file=.env scripts/hive-chat.mjs`);
  console.log(`  换真引擎：打开看板 🔧 组织编辑器 → 点蜂房换脑（或改 engine.adapter 字段）`);
}

main().catch((e) => {
  if (e?.message) console.error(e.message);
  process.exitCode = 1;
});
