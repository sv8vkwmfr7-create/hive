#!/usr/bin/env node
/**
 * 钉钉通道 demo：Stream Mode（免公网）→ 发一句话 → 团队自动跑 → 终态回消息。
 * 前置：open-dev.dingtalk.com 建企业内部应用（H5 微应用即可）
 *       → 应用凭证页拿 appKey/appSecret（robotCode = appKey）
 *       → 「机器人」配置里开启机器人能力、消息接收模式选「Stream 模式」
 *       → hive/.env 填 DINGTALK_APP_KEY + DINGTALK_APP_SECRET
 * 运行：node --env-file=../../.env examples/dingtalk-demo.mjs
 * 可选：HIVE_TEAM=<teams/ 下的模板名>（默认 mock-team）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "@hive/server";
import { createAdapterResolver, startCredentialProxy } from "@hive/adapters";
import { DingTalkConnector, DingTalkClient, startDingTalkStream } from "../dist/index.js";

const { DINGTALK_APP_KEY, DINGTALK_APP_SECRET, HIVE_TEAM } = process.env;
if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) {
  console.error(`缺少钉钉凭据。步骤：
1. open-dev.dingtalk.com → 应用开发 → 企业内部应用（H5 微应用）
2. 应用凭证：appKey / appSecret（robotCode 即 appKey）
3. 应用能力 → 机器人 → 开启，消息接收模式选「Stream 模式」
4. 发布应用版本
5. hive/.env 填 DINGTALK_APP_KEY=<appKey> 和 DINGTALK_APP_SECRET=<appSecret>
6. 钉钉里单聊机器人或群里 @机器人 发一句话即建任务`);
  process.exit(1);
}

const connectorRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const hiveRoot = join(connectorRoot, "..", "..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${HIVE_TEAM ?? "mock-team"}.json`), "utf8"));
const dataDir = join(connectorRoot, "data", `dingtalk-demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const adaptersDir = join(hiveRoot, "packages", "adapters", "adapters");
const proxy = await startCredentialProxy({ adaptersDir, env: process.env });
const workers = createAdapterResolver({ adaptersDir, proxyUrl: proxy.url, proxySecret: proxy.secret });
const kernel = new HiveKernel({ dataDir, chart, workers, vaultDir: process.env.HIVE_VAULT ?? undefined });
const board = await createHiveServer({ kernel, teamsDir: join(hiveRoot, "teams"), adaptersDir });
const client = new DingTalkClient({ appKey: DINGTALK_APP_KEY, appSecret: DINGTALK_APP_SECRET });
const connector = new DingTalkConnector({ kernel, defaultBudgetUsd: 3, log: (m) => console.log(m) }, client);
const stream = await startDingTalkStream({ client, connector, log: (m) => console.log(m) });

console.log(`\n🐝 蜂巢 × 钉钉已就绪`);
console.log(`   看板: http://127.0.0.1:${board.port}`);
console.log(`   团队: ${HIVE_TEAM ?? "mock-team"} · 单聊机器人或群里 @机器人 发一句话即建任务，完成回消息 ✅`);
setInterval(() => {}, 1 << 30);
process.on("SIGINT", () => {
  stream.stop();
  process.exit(0);
});
