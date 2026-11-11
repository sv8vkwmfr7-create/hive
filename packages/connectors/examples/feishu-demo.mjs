#!/usr/bin/env node
/**
 * 飞书连接器 demo：起内核（mock 团队）+ 看板 + webhook 端点。
 * 前置：hive/.env 里填好 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_ENCRYPT_KEY，
 * 运行：node --env-file=../../.env examples/feishu-demo.mjs
 * 飞书事件回调需要公网可达：本地开发用内网穿透（ngrok / ssh -R）或飞书长连接模式（V0.5）。
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "@hive/server";
import { createAdapterResolver, startCredentialProxy } from "@hive/adapters";
import { FeishuConnector, FeishuClient } from "../dist/index.js";

const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_ENCRYPT_KEY, FEISHU_WEBHOOK_ONLY } = process.env;
if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error(`缺少飞书凭据。请到 https://open.feishu.cn 建企业自建应用：
1. 事件订阅 → 模式选"长连接"（免公网，推荐）或"webhook"（需内网穿透）
2. 订阅事件：im.message.receive_v1
3. 权限：im:message（收消息）、im:message:send_as_bot（发消息）
4. 把 App ID / App Secret / Encrypt Key 填进 hive/.env
5. 用 node --env-file=../../.env examples/feishu-demo.mjs 重跑`);
  process.exit(1);
}

const connectorRoot = dirname(fileURLToPath(import.meta.url)) + "/..";
const hiveRoot = join(connectorRoot, "..", "..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams", `${process.env.HIVE_TEAM ?? "mock-team"}.json`), "utf8"));
const dataDir = join(connectorRoot, "data", `feishu-demo-${new Date().toISOString().replace(/[:.]/g, "-")}`);

// 真引擎团队（HIVE_TEAM=real-team）经适配器解析器接入；mock 团队走内置 mock worker。
// 凭据经 --env-file 进入 process.env，resolver 透传给桥接进程（凭据代理：不落盘不进 prompt）。
const proxy = await startCredentialProxy({ adaptersDir: join(hiveRoot, "packages", "adapters", "adapters"), env: process.env });
const workers = createAdapterResolver({ adaptersDir: join(hiveRoot, "packages", "adapters", "adapters"), proxyUrl: proxy.url, proxySecret: proxy.secret });
// 共享大脑：设 HIVE_VAULT=<vault 目录> → 任务 PASS 后交付摘要自动落库（Obsidian）
const kernel = new HiveKernel({ dataDir, chart, workers, vaultDir: process.env.HIVE_VAULT ?? undefined });
const board = await createHiveServer({ kernel });
const client = new FeishuClient({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
const connector = new FeishuConnector({
  kernel,
  client,
  encryptKey: FEISHU_ENCRYPT_KEY,
  defaultBudgetUsd: Number(process.env.FEISHU_DEFAULT_BUDGET_USD ?? 3),
  log: (m) => console.log(m),
});

const webhook = createServer((req, res) => {
  if (req.url?.startsWith("/webhook/feishu") && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void connector
        .handleCallback(body, {
          signature: req.headers["x-lark-signature"],
          timestamp: req.headers["x-lark-request-timestamp"],
          nonce: req.headers["x-lark-request-nonce"],
        })
        .then((r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.body));
        });
    });
    return;
  }
  res.writeHead(404);
  res.end("{}");
});
await new Promise((r) => webhook.listen(7601, "0.0.0.0", r));

console.log(`\n🐝 蜂巢 × 飞书 已就绪`);
console.log(`   看板:     http://127.0.0.1:${board.port}`);

if (FEISHU_WEBHOOK_ONLY === "1") {
  console.log(`   webhook:  http://<公网>:7601/webhook/feishu  ← 填进飞书事件订阅（webhook 模式）`);
} else {
  // 默认长连接模式：官方 SDK WebSocket 直连，不需要公网地址
  const { startFeishuLongConnection } = await import("../dist/index.js");
  await startFeishuLongConnection({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    onEvent: (event) => connector.handleEventObject(event),
    log: (m) => console.log(`[feishu] ${m}`),
  });
  console.log(`   模式:     长连接（免公网）；设 FEISHU_WEBHOOK_ONLY=1 切 webhook 模式`);
}
console.log(`   在飞书群里 @机器人 发一句话，任务自动跑，完成后回帖 ✅`);
setInterval(() => {}, 1 << 30);
