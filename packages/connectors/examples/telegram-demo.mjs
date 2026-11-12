#!/usr/bin/env node
/**
 * Telegram 备胎通道 demo：长轮询（免公网）→ 发一句话 → 团队自动跑 → 终态回帖。
 * 前置：@BotFather 建 bot 拿 token → hive/.env 填 TELEGRAM_BOT_TOKEN
 * 运行：node --env-file=../../.env examples/telegram-demo.mjs
 * 可选：HIVE_TEAM=<teams/ 下的模板名>（默认 mock-team）；TELEGRAM_API_BASE 指向离线假服务器
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "@hive/server";
import { createAdapterResolver, startCredentialProxy } from "@hive/adapters";
import { TelegramConnector, TelegramClient, startTelegramPolling } from "../dist/index.js";

const { TELEGRAM_BOT_TOKEN, HIVE_TEAM, TELEGRAM_API_BASE } = process.env;
if (!TELEGRAM_BOT_TOKEN) {
  console.error(`缺少 Telegram 凭据。步骤：
1. Telegram 里找 @BotFather → /newbot → 拿 token
2. hive/.env 填 TELEGRAM_BOT_TOKEN=<token>
3. 和 bot 建对话（或拉进群）后重跑本 demo
4. 私聊里直接发一句话即可建任务（斜杠命令不建任务）`);
  process.exit(1);
}

const connectorRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const hiveRoot = join(connectorRoot, "..", "..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${HIVE_TEAM ?? "mock-team"}.json`), "utf8"));
const dataDir = join(connectorRoot, "data", `tg-demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const proxy = await startCredentialProxy({ adaptersDir: join(hiveRoot, "packages", "adapters", "adapters"), env: process.env });
const workers = createAdapterResolver({ adaptersDir: join(hiveRoot, "packages", "adapters", "adapters"), proxyUrl: proxy.url, proxySecret: proxy.secret });
const kernel = new HiveKernel({ dataDir, chart, workers, vaultDir: process.env.HIVE_VAULT ?? undefined });
const board = await createHiveServer({ kernel, teamsDir: join(hiveRoot, "teams"), adaptersDir: join(hiveRoot, "packages", "adapters", "adapters") });
const client = new TelegramClient({ token: TELEGRAM_BOT_TOKEN, baseUrl: TELEGRAM_API_BASE });
const connector = new TelegramConnector({
  kernel,
  defaultBudgetUsd: Number(process.env.TELEGRAM_DEFAULT_BUDGET_USD ?? 3),
  log: (m) => console.log(m),
});
connector.attachClient(client);
startTelegramPolling({ client, connector, log: (m) => console.log(m) });

console.log(`\n🐝 蜂巢 × Telegram（备胎通道）已就绪`);
console.log(`   看板: http://127.0.0.1:${board.port}`);
console.log(`   团队: ${HIVE_TEAM ?? "mock-team"} · 私聊 bot 发一句话即建任务，完成回帖 ✅`);
setInterval(() => {}, 1 << 30);
