#!/usr/bin/env node
/**
 * Discord 通道 demo：gateway WebSocket（免公网）→ 发一句话 → 团队自动跑 → 终态回帖。
 * 前置：Discord Developer Portal 建应用 → Bot → 拿 token（开 MESSAGE CONTENT intent）
 *       → 把 bot 拉进服务器/私聊 → hive/.env 填 DISCORD_BOT_TOKEN
 * 运行：node --env-file=../../.env examples/discord-demo.mjs
 * 可选：HIVE_TEAM=<teams/ 下的模板名>（默认 mock-team）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "@hive/server";
import { createAdapterResolver, startCredentialProxy } from "@hive/adapters";
import { DiscordConnector, DiscordClient, startDiscordGateway } from "../dist/index.js";

const { DISCORD_BOT_TOKEN, HIVE_TEAM } = process.env;
if (!DISCORD_BOT_TOKEN) {
  console.error(`缺少 Discord 凭据。步骤：
1. https://discord.com/developers/applications → New Application → Bot → Reset Token
2. 开 MESSAGE CONTENT INTENT
3. hive/.env 填 DISCORD_BOT_TOKEN=<token>
4. 把 bot 拉进服务器（OAuth2 URL Generator scopes=bot）或直接私聊后重跑本 demo
5. 频道里发一句话即建任务（bot 自发消息与斜杠命令不建任务）`);
  process.exit(1);
}

const connectorRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const hiveRoot = join(connectorRoot, "..", "..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${HIVE_TEAM ?? "mock-team"}.json`), "utf8"));
const dataDir = join(connectorRoot, "data", `discord-demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const adaptersDir = join(hiveRoot, "packages", "adapters", "adapters");
const proxy = await startCredentialProxy({ adaptersDir, env: process.env });
const workers = createAdapterResolver({ adaptersDir, proxyUrl: proxy.url, proxySecret: proxy.secret });
const kernel = new HiveKernel({ dataDir, chart, workers, vaultDir: process.env.HIVE_VAULT ?? undefined });
const board = await createHiveServer({ kernel, teamsDir: join(hiveRoot, "teams"), adaptersDir: join(hiveRoot, "packages", "adapters", "adapters") });
const client = new DiscordClient({ token: DISCORD_BOT_TOKEN });
const connector = new DiscordConnector({ kernel, defaultBudgetUsd: 3, log: (m) => console.log(m) }, client);
const gateway = startDiscordGateway({ client, connector, log: (m) => console.log(m) });

console.log(`\n🐝 蜂巢 × Discord 已就绪`);
console.log(`   看板: http://127.0.0.1:${board.port}`);
console.log(`   团队: ${HIVE_TEAM ?? "mock-team"} · 频道里发一句话即建任务，完成回帖 ✅`);
setInterval(() => {}, 1 << 30);
process.on("SIGINT", () => {
  gateway.stop();
  process.exit(0);
});
