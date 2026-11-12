#!/usr/bin/env node
/**
 * Slack 通道 demo：Socket Mode（免公网）→ 发一句话 → 团队自动跑 → 终态回帖。
 * 前置：api.slack.com/apps → Create App → 启 Socket Mode（拿 xapp- App-Level Token）
 *       → OAuth & Permissions 装 app（拿 xoxb- Bot Token，scopes: chat:write）
 *       → Event Subscriptions 订阅 message.im / app_mention → 装进工作区
 *       → hive/.env 填 SLACK_BOT_TOKEN + SLACK_APP_TOKEN
 * 运行：node --env-file=../../.env examples/slack-demo.mjs
 * 可选：HIVE_TEAM=<teams/ 下的模板名>（默认 mock-team）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "@hive/server";
import { createAdapterResolver, startCredentialProxy } from "@hive/adapters";
import { SlackConnector, SlackClient, startSlackSocket } from "../dist/index.js";

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN, HIVE_TEAM } = process.env;
if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error(`缺少 Slack 凭据。步骤：
1. https://api.slack.com/apps → Create New App（from scratch）
2. Socket Mode → Enable → 创建 App-Level Token（connections:write）→ xapp-… 填 SLACK_APP_TOKEN
3. OAuth & Permissions → Bot Token Scopes 加 chat:write → Install → xoxb-… 填 SLACK_BOT_TOKEN
4. Event Subscriptions → Enable → Subscribe to bot events：message.im、app_mention
5. 把 bot 拉进频道或私聊 → 发一句话即建任务（bot 自发/subtype/斜杠不建任务）`);
  process.exit(1);
}

const connectorRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const hiveRoot = join(connectorRoot, "..", "..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${HIVE_TEAM ?? "mock-team"}.json`), "utf8"));
const dataDir = join(connectorRoot, "data", `slack-demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const adaptersDir = join(hiveRoot, "packages", "adapters", "adapters");
const proxy = await startCredentialProxy({ adaptersDir, env: process.env });
const workers = createAdapterResolver({ adaptersDir, proxyUrl: proxy.url, proxySecret: proxy.secret });
const kernel = new HiveKernel({ dataDir, chart, workers, vaultDir: process.env.HIVE_VAULT ?? undefined });
const board = await createHiveServer({ kernel, teamsDir: join(hiveRoot, "teams"), adaptersDir });
const client = new SlackClient({ botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN });
const connector = new SlackConnector({ kernel, defaultBudgetUsd: 3, log: (m) => console.log(m) }, client);
const socket = startSlackSocket({ client, connector, log: (m) => console.log(m) });

console.log(`\n🐝 蜂巢 × Slack 已就绪`);
console.log(`   看板: http://127.0.0.1:${board.port}`);
console.log(`   团队: ${HIVE_TEAM ?? "mock-team"} · 频道里发一句话即建任务，完成回帖 ✅`);
setInterval(() => {}, 1 << 30);
process.on("SIGINT", () => {
  socket.stop();
  process.exit(0);
});
