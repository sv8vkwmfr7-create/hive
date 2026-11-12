#!/usr/bin/env node
/**
 * 企微通道 demo：自建应用回调（回调模式需公网 URL，如 cloudflared/ngrok 转发本端口）
 * → 发一句话 → 团队自动跑 → 应用消息回帖。
 * 前置：work.weixin.qq.com 管理后台 → 应用管理 → 自建应用
 *       → 拿 AgentId + 应用 Secret；企业 ID（我的企业页）
 *       → 「接收消息」→ 设置 API 接收：URL 填 <公网地址>/wecom/callback，随机生成
 *         Token 与 EncodingAESKey → 填进 hive/.env → 先起本 demo 再点保存（验证 GET 要过）
 * 运行：node --env-file=../../.env examples/wecom-demo.mjs
 * 可选：HIVE_TEAM=<teams/ 下的模板名>（默认 mock-team）+ PORT（默认 8081）
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "@hive/server";
import { createAdapterResolver, startCredentialProxy } from "@hive/adapters";
import { WeComConnector, WeComClient } from "../dist/index.js";

const { WECOM_CORP_ID, WECOM_CORP_SECRET, WECOM_AGENT_ID, WECOM_TOKEN, WECOM_ENCODING_AES_KEY, HIVE_TEAM, PORT } = process.env;
if (!WECOM_CORP_ID || !WECOM_CORP_SECRET || !WECOM_AGENT_ID || !WECOM_TOKEN || !WECOM_ENCODING_AES_KEY) {
  console.error(`缺少企微凭据。步骤：
1. work.weixin.qq.com 管理后台 → 应用管理 → 创建应用（自建）
   → 记 AgentId、应用 Secret；「我的企业」页记企业 ID
2. 应用详情 → 接收消息 → 设置 API 接收
   → 随机生成 Token 与 EncodingAESKey → 填进 hive/.env：
     WECOM_CORP_ID=<企业ID> WECOM_CORP_SECRET=<应用Secret>
     WECOM_AGENT_ID=<AgentId> WECOM_TOKEN=<Token> WECOM_ENCODING_AES_KEY=<EncodingAESKey>
3. URL 填 <公网地址>/wecom/callback（本机调试可 cloudflared tunnel --url http://127.0.0.1:8081）
4. 先跑本 demo（验证 GET 要通）再在后台点「保存」
5. 企业微信里给应用发一句话即建任务`);
  process.exit(1);
}

const connectorRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const hiveRoot = join(connectorRoot, "..", "..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${HIVE_TEAM ?? "mock-team"}.json`), "utf8"));
const dataDir = join(connectorRoot, "data", `wecom-demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const adaptersDir = join(hiveRoot, "packages", "adapters", "adapters");
const proxy = await startCredentialProxy({ adaptersDir, env: process.env });
const workers = createAdapterResolver({ adaptersDir, proxyUrl: proxy.url, proxySecret: proxy.secret });
const kernel = new HiveKernel({ dataDir, chart, workers, vaultDir: process.env.HIVE_VAULT ?? undefined });
const board = await createHiveServer({ kernel, teamsDir: join(hiveRoot, "teams"), adaptersDir });
const client = new WeComClient({ corpId: WECOM_CORP_ID, corpSecret: WECOM_CORP_SECRET });
const connector = new WeComConnector(
  { kernel, token: WECOM_TOKEN, encodingAesKey: WECOM_ENCODING_AES_KEY, corpId: WECOM_CORP_ID, defaultBudgetUsd: 3, log: (m) => console.log(m) },
  client,
);

// 回调入口：GET = URL 验证（echostr 明文回显），POST = 消息回调
const httpPort = Number(PORT ?? 8081);
createServer((req, res) => {
  const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (u.pathname !== "/wecom/callback") {
    res.writeHead(404).end();
    return;
  }
  const q = Object.fromEntries(u.searchParams);
  if (req.method === "GET") {
    const r = connector.handleVerifyUrl({ msg_signature: q.msg_signature, timestamp: q.timestamp, nonce: q.nonce, echostr: q.echostr });
    res.writeHead(r.status, { "content-type": "text/plain" });
    res.end(r.reply);
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const r = connector.handleCallback({ msg_signature: q.msg_signature, timestamp: q.timestamp, nonce: q.nonce, body });
    res.writeHead(r.status, { "content-type": "text/plain" });
    res.end(r.reply);
  });
}).listen(httpPort, "127.0.0.1");

console.log(`\n🐝 蜂巢 × 企业微信已就绪`);
console.log(`   看板: http://127.0.0.1:${board.port}`);
console.log(`   回调: http://127.0.0.1:${httpPort}/wecom/callback（配到企微接收消息 URL，需公网可达）`);
console.log(`   团队: ${HIVE_TEAM ?? "mock-team"} · 企业微信里给应用发一句话即建任务，完成应用消息回帖 ✅`);
setInterval(() => {}, 1 << 30);
process.on("SIGINT", () => {
  connector.close();
  process.exit(0);
});
