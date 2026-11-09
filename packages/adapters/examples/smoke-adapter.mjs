#!/usr/bin/env node
/**
 * 引擎适配器冒烟脚本：不跑完整任务，只单发一个 bot 头less 调用，验证契约→引擎→桥接→协议链路。
 * 用法：node examples/smoke-adapter.mjs <adapterId>   如 codex / claude-code / deepseek
 * codex 额度 2026-11-14 01:08 重置后，跑 `pnpm --filter @hive/adapters smoke -- codex` 即插即用复冒烟。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAdapter } from "../dist/contract.js";
import { runBridge } from "../dist/bridge.js";

const adaptersDir = join(dirname(fileURLToPath(import.meta.url)), "..", "adapters");
// 兼容两种调用：`pnpm smoke -- codex`（pnpm 11 会把 -- 原样传进来）与 `node smoke-adapter.mjs codex`
const adapterId = process.argv.slice(2).filter((a) => a !== "--")[0];
if (!adapterId) {
  console.error("用法：node examples/smoke-adapter.mjs <adapterId>（adapters/ 目录下的契约名，如 codex）");
  process.exit(1);
}

const contract = loadAdapter(join(adaptersDir, `${adapterId}.json`));
console.log(`── 冒烟：${adapterId}（${contract.kind}/${contract.mode}，tier ${contract.tier ?? "?"}）──`);
console.log(`spawn/base: ${contract.spawn ?? contract.base_url}`);

const pack = {
  taskId: "smoke",
  botId: "smoke-bot",
  role: "specialist",
  instruction: "冒烟测试：用一句话介绍你自己，然后产出一份 3 行的 hello.md",
  artifactDir: mkdtempSync(join(tmpdir(), "hive-smoke-")),
  inputArtifacts: [],
};

const result = await runBridge(pack, contract);
console.log(`退出码：${result.exitCode}（0 = 协议链路通）`);
process.exit(result.exitCode);
