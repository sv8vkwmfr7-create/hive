#!/usr/bin/env node
/**
 * 凭据资产盘点：扫描本机已知配置位置，只输出「变量名 + 值长度 + 所在文件」，
 * 绝不输出值本身。用途：点火前确认哪些引擎凭据已在机器上存在（可直接复用）。
 * 覆盖：~/.cc-switch、~/.claude*、~/.zcode、Desktop 下浅层 .env* 文件。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const files = [];

const addDir = (dir) => {
  if (!existsSync(dir)) return;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (/\.(json|toml|yaml|yml|env|txt)$/i.test(e.name)) files.push(join(dir, e.name));
  }
};
addDir(join(home, ".cc-switch"));
for (const f of [".claude.json", ".claude.json.backup", ".claude/settings.json", ".claude/settings.local.json"]) {
  const p = join(home, f);
  if (existsSync(p) && statSync(p).isFile()) files.push(p);
}
addDir(join(home, ".zcode"));
addDir(join(home, ".zcode", "cli"));

// Desktop 浅层 .env / 配置（知识库 + 团队bot），跳 node_modules 与 .git
for (const root of [join(home, "Desktop", "知识库"), join(home, "Desktop", "团队bot")]) {
  if (!existsSync(root)) continue;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name.startsWith(".git")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.env(\..+)?$|\.env$/.test(e.name)) files.push(p);
    }
  };
  walk(root, 0);
}

// 候选 key 字段（值 ≥16 字符才算；不打印值）
const pat = /([A-Za-z0-9_]{0,24}(?:API_?KEY|TOKEN|SECRET|_KEY|api_?key|token|secret|apiKey|api_key)[A-Za-z0-9_]{0,24})\s*[:=]\s*["']?([A-Za-z0-9_\-]{16,})["']?/g;
const urlPat = /(https?:\/\/[^"'\s,}]+)/g;

const seen = new Set();
let hits = 0;
for (const f of files) {
  if (seen.has(f)) continue;
  seen.add(f);
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const found = [];
  let m;
  while ((m = pat.exec(text))) {
    const varName = m[1];
    const len = m[2].length;
    // 长得像注释/示例的跳过
    if (/example|placeholder|your[-_]/i.test(varName)) continue;
    found.push(`${varName} ← ${len} 字符`);
  }
  const urls = [...text.matchAll(urlPat)].map((x) => x[1].split("?")[0])
    .filter((u) => /deepseek|bigmodel|zai|open\.feishu|larksuite|openrouter|moonshot|dashscope|volces|siliconflow/i.test(u));
  if (found.length || urls.length) {
    hits++;
    console.log("── " + f.replace(home, "~"));
    for (const x of found.slice(0, 12)) console.log("   " + x);
    for (const u of [...new Set(urls)].slice(0, 6)) console.log("   url: " + u);
  }
}
console.log(`\n扫描完成：${files.length} 个候选文件，${hits} 个命中`);
