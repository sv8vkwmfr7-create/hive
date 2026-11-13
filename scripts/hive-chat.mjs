#!/usr/bin/env node
/**
 * 蜂巢聊天统一入口：自动检测 hive/.env 里已填的通道凭据并起对应通道。
 * 用法：node --env-file=.env scripts/hive-chat.mjs [HIVE_TEAM=real-team-ds]
 * 四通道（填任一即可）：TELEGRAM_BOT_TOKEN（最快，@BotFather 一分钟）
 *                      FEISHU_APP_ID/SECRET/ENCRYPT_KEY（长连接免公网）
 *                      DISCORD_BOT_TOKEN（Developer Portal，开 MESSAGE CONTENT intent）
 *                      SLACK_BOT_TOKEN + SLACK_APP_TOKEN（Socket Mode 免公网）
 *                      DINGTALK_APP_KEY/SECRET（Stream Mode 免公网，robotCode=appKey）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "../packages/kernel/dist/index.js";
import { createHiveServer } from "../packages/server/dist/index.js";
import { createAdapterResolver, startCredentialProxy } from "../packages/adapters/dist/index.js";
import { FeishuConnector, FeishuClient, startFeishuLongConnection } from "../packages/connectors/dist/index.js";
import { TelegramConnector, TelegramClient, startTelegramPolling } from "../packages/connectors/dist/index.js";
import { DiscordConnector, DiscordClient, startDiscordGateway } from "../packages/connectors/dist/index.js";
import { SlackConnector, SlackClient, startSlackSocket } from "../packages/connectors/dist/index.js";
import { DingTalkConnector, DingTalkClient, startDingTalkStream } from "../packages/connectors/dist/index.js";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(scriptRoot, "..");
const teamName = process.env.HIVE_TEAM ?? "real-team-ds";
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${teamName}.json`), "utf8"));

// 通道检测（读 process.env，凭据由 --env-file 注入，绝不打印值）
const channels = {
  telegram: !!process.env.TELEGRAM_BOT_TOKEN,
  feishu: !!process.env.FEISHU_APP_ID && !!process.env.FEISHU_APP_SECRET,
  discord: !!process.env.DISCORD_BOT_TOKEN,
  slack: !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_APP_TOKEN,
  dingtalk: !!process.env.DINGTALK_APP_KEY && !!process.env.DINGTALK_APP_SECRET,
};
const ready = Object.entries(channels).filter(([, ok]) => ok);
if (ready.length === 0) {
  console.error(`聊天凭据未配置——五选一填进 hive/.env 后重跑本脚本：

  ① Telegram（最快，约 1 分钟）
     Telegram 里找 @BotFather → /newbot → 拿 token
     → hive/.env 填 TELEGRAM_BOT_TOKEN=<token>

  ② 飞书（约 15 分钟）
     open.feishu.cn 建企业自建应用（长连接模式、订阅 im.message.receive_v1、
     权限 im:message + im:message:send_as_bot）
     → hive/.env 填 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_ENCRYPT_KEY

  ③ Discord（约 5 分钟）
     discord.com/developers/applications → New Application → Bot → Reset Token
     （开 MESSAGE CONTENT INTENT）→ 拉进服务器
     → hive/.env 填 DISCORD_BOT_TOKEN=<token>

  ④ Slack（约 10 分钟）
     api.slack.com/apps → Create App → Socket Mode 启用拿 xapp-（App-Level Token）
     → OAuth 装 app 拿 xoxb-（scopes: chat:write）→ 订阅 message.im + app_mention
     → hive/.env 填 SLACK_BOT_TOKEN=<xoxb-…> 和 SLACK_APP_TOKEN=<xapp-…>

  ⑤ 钉钉（约 10 分钟）
     open-dev.dingtalk.com → 企业内部应用（H5 微应用）→ 拿 appKey/appSecret
     → 应用能力 → 机器人开启，消息接收模式选「Stream 模式」→ 发布版本
     → hive/.env 填 DINGTALK_APP_KEY=<appKey> 和 DINGTALK_APP_SECRET=<appSecret>

填好后：node --env-file=.env scripts/hive-chat.mjs  → 聊天里发一句话 → 团队交付 ✅`);
  process.exit(1);
}

// HIVE_DATA_DIR 可指定既有数据目录重启：内核从事件流重建任务视图与预算（一切皆事件）
const dataDir = process.env.HIVE_DATA_DIR ?? join(hiveRoot, "data", `hive-chat-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const adaptersDir = join(hiveRoot, "packages", "adapters", "adapters");
const proxy = await startCredentialProxy({ adaptersDir, env: process.env });
const workers = createAdapterResolver({ adaptersDir, proxyUrl: proxy.url, proxySecret: proxy.secret });
const kernel = new HiveKernel({
  dataDir,
  chart,
  workers,
  vaultDir: process.env.HIVE_VAULT ?? undefined,
});
const board = await createHiveServer({
  kernel,
  teamsDir: join(hiveRoot, "teams"),
  adaptersDir,
});
const budget = Number(process.env.FEISHU_DEFAULT_BUDGET_USD ?? 3);

console.log(`\n🐝 蜂巢 · 聊天通道已就绪`);
console.log(`   团队: ${teamName}（凭据代理 ${proxy.url}）`);
console.log(`   看板: http://127.0.0.1:${board.port}`);
console.log(`   通道: ${ready.map(([k]) => k).join(" + ")}`);
console.log(`   → 在聊天里发一句话，团队自动拆解→分派→协作→互审→交付，账单落盘 ✅\n`);

const log = (m) => console.log(m);

// Telegram（长轮询免公网）
if (channels.telegram) {
  const client = new TelegramClient({ token: process.env.TELEGRAM_BOT_TOKEN });
  const connector = new TelegramConnector({ kernel, defaultBudgetUsd: budget, log });
  connector.attachClient(client);
  startTelegramPolling({ client, connector, log, intervalMs: 1500 });
  console.log("   telegram: 长轮询运行中（@你的 bot 私聊/群里发消息）");
}
// Discord（gateway WS 免公网）
if (channels.discord) {
  const client = new DiscordClient({ token: process.env.DISCORD_BOT_TOKEN });
  const connector = new DiscordConnector({ kernel, defaultBudgetUsd: budget, log }, client);
  startDiscordGateway({ client, connector, log });
  console.log("   discord: gateway 运行中（频道里发消息）");
}
// Slack（Socket Mode 免公网）
if (channels.slack) {
  const client = new SlackClient({ botToken: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN });
  const connector = new SlackConnector({ kernel, defaultBudgetUsd: budget, log }, client);
  startSlackSocket({ client, connector, log });
  console.log("   slack: socket mode 运行中（频道/私聊发消息）");
}
// 钉钉（Stream Mode 免公网）
if (channels.dingtalk) {
  const client = new DingTalkClient({ appKey: process.env.DINGTALK_APP_KEY, appSecret: process.env.DINGTALK_APP_SECRET });
  const connector = new DingTalkConnector({ kernel, defaultBudgetUsd: budget, log }, client);
  await startDingTalkStream({ client, connector, log });
  console.log("   dingtalk: stream mode 运行中（单聊机器人/群里 @机器人）");
}
// 飞书（官方 SDK 长连接免公网）
if (channels.feishu) {
  const client = new FeishuClient({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
  });
  const connector = new FeishuConnector({
    kernel,
    client,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY,
    defaultBudgetUsd: budget,
    log,
  });
  await startFeishuLongConnection({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    onEvent: (event) => connector.handleEventObject(event),
    log,
  });
  console.log("   feishu: 长连接运行中（群里 @机器人 发消息）");
}
// 支持多通道并存：同一内核，谁发的话都建任务（source 前缀区分来源）
setInterval(() => {}, 1 << 30);
