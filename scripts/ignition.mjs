#!/usr/bin/env node
/**
 * 蜂巢点火自检：一条命令盘点 MVP 点火的全部前置条件。
 * 用法（在 hive/ 目录）：
 *   node scripts/ignition.mjs            # 盘点模式：零成本，只查凭据与引擎安装态
 *   node --env-file=.env scripts/ignition.mjs --smoke   # 点火模式：对已就绪引擎跑真冒烟（deepseek 小额计费）
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hiveRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const smoke = process.argv.includes("--smoke");
const env = process.env;
const has = (k) => Boolean(env[k] && env[k].length > 0);

const lines = [];
const row = (icon, label, detail) => lines.push(`${icon} ${label.padEnd(28)}${detail}`);

console.log(`\n🐝 蜂巢点火自检（${smoke ? "点火模式：真冒烟" : "盘点模式：零成本"}）\n`);

// ---- 凭据 ----
const feishuReady = has("FEISHU_APP_ID") && has("FEISHU_APP_SECRET");
row(has("FEISHU_APP_ID") ? "✅" : "⬜", "FEISHU_APP_ID", has("FEISHU_APP_ID") ? "已填" : "缺（开放平台建应用，见 packages/connectors/README.md）");
row(has("FEISHU_APP_SECRET") ? "✅" : "⬜", "FEISHU_APP_SECRET", has("FEISHU_APP_SECRET") ? "已填" : "缺");
row(has("FEISHU_ENCRYPT_KEY") ? "✅" : "⚠️ ", "FEISHU_ENCRYPT_KEY", has("FEISHU_ENCRYPT_KEY") ? "已填" : "未填（回调将不加密；生产建议填）");
row(has("DEEPSEEK_API_KEY") ? "✅" : "⬜", "DEEPSEEK_API_KEY", has("DEEPSEEK_API_KEY") ? "已填" : "缺（DeepSeek 平台或 TokenHub）");

// ---- .env 本体 ----
row(existsSync(join(hiveRoot, ".env")) ? "✅" : "⬜", "hive/.env", existsSync(join(hiveRoot, ".env")) ? "存在（node --env-file=.env 使用）" : "缺（从 .env.example 复制）");

// ---- 引擎 CLI 安装态 ----
for (const cli of ["codex", "claude", "zcode"]) {
  const v = spawnSync(`${cli} --version`, { encoding: "utf8", shell: true, timeout: 20000 });
  row(v.status === 0 ? "✅" : "❌", `CLI: ${cli}`, v.status === 0 ? String(v.stdout).split("\n")[0].trim() : "不可用");
}

// ---- 冒烟 ----
if (smoke) {
  console.log("\n── 真引擎冒烟（adapters 桥接全链路）──");
  const targets = [];
  if (has("DEEPSEEK_API_KEY")) targets.push("deepseek");
  targets.push("claude-code", "codex"); // 装了就试，失败如实报
  for (const id of targets) {
    const r = spawnSync(process.execPath, [join(hiveRoot, "packages/adapters/examples/smoke-adapter.mjs"), id], {
      encoding: "utf8",
      timeout: 120000,
      env,
    });
    const ok = r.status === 0;
    const tail = String(r.stdout).trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
    row(ok ? "✅" : "⛔", `smoke: ${id}`, ok ? tail || "协议链路通" : String(r.stderr).trim().split("\n").slice(-1)[0]?.slice(0, 100) || `退出码 ${r.status}`);
  }
}

// ---- 结论 ----
const blockers = [];
if (!feishuReady) blockers.push("飞书凭据（FEISHU_APP_ID/SECRET）→ 聊天真回调");
if (!has("DEEPSEEK_API_KEY")) blockers.push("DEEPSEEK_API_KEY → DeepSeek 引擎");
console.log(`\n── 结论 ──`);
if (blockers.length === 0) {
  console.log("点火条件全部就绪：跑 node --env-file=.env scripts/ignition.mjs --smoke 复核引擎，然后起 feishu-demo 做真回调联调。");
} else {
  console.log(`还差 ${blockers.length} 项（都在用户侧）：`);
  for (const b of blockers) console.log(`  ⬜ ${b}`);
}
console.log(lines.join("\n"));
