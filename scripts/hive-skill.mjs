#!/usr/bin/env node
/**
 * 技能锻造厂 CLI：好做法 → 可复用技能（skills/*.md，任务指令命中 applies 即自动挂载）。
 *
 *   node scripts/hive-skill.mjs new <名称> [--applies 关键词1,关键词2]   # 建技能骨架（编辑正文成做法）
 *   node scripts/hive-skill.mjs list                                    # 列出全部技能 + 校验提醒
 *   node scripts/hive-skill.mjs forge <dataDir> <taskId> <名称>          # 从已验收任务抽骨架（产物清单+PASS 证据），人补正文
 *
 * 退出方式走 process.exitCode（fetch keep-alive 的 libuv 断言同族规避）。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSkillFile, validateSkills } from "../packages/shared/dist/index.js";

const hiveRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(hiveRoot, "skills");

const args = process.argv.slice(2).filter((a) => a !== "--");

function skillFiles() {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      try {
        return parseSkillFile(readFileSync(join(skillsDir, f), "utf8"), f.replace(/\.md$/, ""));
      } catch (e) {
        return { name: `（坏文件 ${f}）`, description: String(e?.message ?? e), applies: [], body: "", file: f };
      }
    });
}

function slug(name) {
  const s = name.trim().replace(/\s+/g, "-");
  return /^[\w\u4e00-\u9fa5-]+$/.test(s) ? s : null;
}

function cmdNew(name, appliesArg) {
  if (!name) throw new Error("用法：hive-skill.mjs new <名称> [--applies 关键词1,关键词2]");
  const file = join(skillsDir, `${slug(name) ?? name}.md`);
  if (existsSync(file)) throw new Error(`skills/${slug(name) ?? name}.md 已存在——直接编辑它，或换名`);
  const applies = (appliesArg ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: （一句话：这个技能教 bot 什么好做法）\napplies: [${applies.join(", ")}]\n---\n\n# ${name}\n\n（在这里写做法本体：结构、口径、红线。任务指令命中 applies 关键词的每一单都会自动带上这段。）\n`,
    "utf8",
  );
  console.log(`✅ 技能骨架已建：skills/${slug(name) ?? name}.md`);
  console.log("   编辑正文成做法本体即可生效（命中率由 applies 关键词决定）");
}

function cmdList() {
  const skills = skillFiles();
  if (!skills.length) {
    console.log("skills/ 目录为空——用 `hive-skill.mjs new <名称>` 建第一个技能。");
    return;
  }
  for (const s of skills) {
    const scope = s.applies.length ? s.applies.join("/") : "全局（每单）";
    console.log(`🧰 ${s.name}（${s.file}.md）· 命中词：${scope} · ${s.description || "（无描述）"} · 正文 ${s.body.length} 字`);
  }
  for (const p of validateSkills(skills)) console.log("  ⚠️ " + p);
}

/** 锻造：从已验收任务的产物与 PASS 证据抽技能骨架（人补正文） */
function cmdForge(dataDir, taskId, name) {
  if (!dataDir || !taskId || !name) throw new Error("用法：hive-skill.mjs forge <dataDir> <taskId> <名称>");
  const eventsPath = join(hiveRoot, dataDir.startsWith("data/") ? dataDir : `data/${dataDir}`, "events.jsonl");
  if (!existsSync(eventsPath)) throw new Error(`事件流不存在：${eventsPath}`);
  const lines = readFileSync(eventsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const task = lines.filter((e) => String(e.taskId) === String(taskId));
  if (!task.length) throw new Error(`事件流里没有任务 #${taskId}`);
  const created = task.find((e) => e.kind === "task.created")?.payload ?? {};
  const artifacts = task.filter((e) => e.kind === "artifact.produced").map((e) => String(e.payload?.path).split(/[\\/]/).at(-1));
  const verdict = task.filter((e) => e.kind === "review.verdict").at(-1)?.payload ?? {};
  const receipt = task.filter((e) => e.kind === "cost.recorded").reduce((sum, e) => sum + (e.payload?.usd ?? 0), 0);
  if (verdict.verdict !== "PASS") throw new Error(`任务 #${taskId} 未通过审核（${verdict.verdict ?? "无结论"}）——只锻造 PASS 的好做法`);

  const file = join(skillsDir, `${slug(name) ?? name}.md`);
  if (existsSync(file)) throw new Error(`skills/${slug(name) ?? name}.md 已存在`);
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: （一句话：这单做对了什么，值得沉淀）\napplies: [${(created.title ?? "").slice(0, 12)}]\n---\n\n# ${name}\n\n## 来源\n\n- 任务 #${taskId}「${created.title ?? ""}」（审核 PASS，花费 $${receipt.toFixed(4)}）\n- 产物：${artifacts.join("、") || "（无）"}\n- 审核证据：${verdict.evidence ?? verdict.reason ?? ""}\n\n## 做法（人补：把这一单做对的步骤写成可复用的口径）\n\n1. \n2. \n3. \n`,
    "utf8",
  );
  console.log(`✅ 技能草稿已锻出：skills/${slug(name) ?? name}.md`);
  console.log("   已含任务来源与审核证据——补全「做法」段落即可生效");
}

async function main() {
  const cmd = args[0];
  switch (cmd) {
    case "new":
      cmdNew(args[1], args[args.indexOf("--applies") + 1]);
      break;
    case "list":
      cmdList();
      break;
    case "forge":
      cmdForge(args[1], args[2], args[3]);
      break;
    default:
      throw new Error("用法：hive-skill.mjs new <名> [--applies a,b] | list | forge <dataDir> <taskId> <名>");
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 1;
});
