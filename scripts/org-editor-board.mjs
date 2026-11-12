#!/usr/bin/env node
/**
 * 组织编辑器验收看板：起 HiveServer（mock 团队 + teamsDir），供浏览器操作 org.html。
 * 用后 Ctrl+C 关掉；仅验收用，不进北极星链路。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "../packages/kernel/dist/index.js";
import { createAdapterResolver } from "../packages/adapters/dist/index.js";
import { createHiveServer } from "../packages/server/dist/index.js";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(scriptRoot, "..");
const teamName = process.env.HIVE_TEAM ?? "mock-team";
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${teamName}.json`), "utf8"));

const workers = createAdapterResolver({ adaptersDir: join(hiveRoot, "packages", "adapters", "adapters") });
const dataDir = join(hiveRoot, "data", `org-editor-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const kernel = new HiveKernel({ dataDir, chart, workers });
const board = await createHiveServer({ kernel, teamsDir: join(hiveRoot, "teams"), adaptersDir: join(hiveRoot, "packages", "adapters", "adapters") });

console.log(`\n🔧 组织编辑器验收看板：http://127.0.0.1:${board.port}/org.html（团队=${teamName}）\n`);
