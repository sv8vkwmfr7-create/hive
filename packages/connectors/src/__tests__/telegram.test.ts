import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { TelegramConnector, TelegramClient, startTelegramPolling } from "../index.js";
import { parseTelegramUpdate } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url)); // dist/__tests__
const hiveRoot = join(here, "../../../..");
const mockChart = JSON.parse(readFileSync(join(hiveRoot, "teams/mock-team.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假 Telegram 服务器：getUpdates 按队列吐更新，sendMessage 记录收到的消息与查询参数 */
function fakeTelegram(updates: unknown[]) {
  const seen: { method: string; query: URLSearchParams; body: unknown }[] = [];
  const queue = [...updates];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.endsWith("/getUpdates")) {
      seen.push({ method: "getUpdates", query: url.searchParams, body: null });
      const batch = queue.shift() ?? [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: batch }));
      return;
    }
    if (url.pathname.endsWith("/sendMessage")) {
      let body = "";
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        seen.push({ method: "sendMessage", query: new URLSearchParams(), body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  return { server, seen };
}

const update = {
  update_id: 100,
  message: { message_id: 1, chat: { id: 777 }, from: { id: 42 }, text: "调研竞品并出简报" },
};

test("Telegram 备胎通道：长轮询 → 建任务 → mock 团队跑完 → 终态回帖（offset 推进）", async () => {
  const { server, seen } = fakeTelegram([[update]]);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  const client = new TelegramClient({ token: "fake-token", baseUrl: `http://127.0.0.1:${port}` });
  const connector = new TelegramConnector({
    kernel: new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-tg-")), chart: mockChart }),
    log: () => {},
  });
  connector.attachClient(client);

  const next = await connector.pollOnce(client, 0);
  assert.equal(next, 101, "offset 应推进到 update_id+1");
  assert.equal(seen[0].method, "getUpdates");
  for (let i = 0; i < 30 && client.sent.length === 0; i++) await sleep(100); // 等 mock 团队跑完并回帖

  const store = connector["opts"].kernel.store;
  const created = store.allEvents().filter((e) => e.kind === "task.created");
  assert.equal(created.length, 1, "一条消息应建一个任务");
  const source = (created[0].payload as { source?: string }).source ?? "";
  assert.equal(source, "telegram:777:42");

  assert.equal(client.sent.length, 1, "终态应回帖一次");
  assert.match(client.sent[0].text, /✅ 蜂巢 · 任务 #1/);
  assert.match(client.sent[0].text, /花费：\$/);
  assert.equal(client.sent[0].chatId, "777");
  server.close();
});

test("轮询循环：startTelegramPolling 持续拉取且错误不中断", async () => {
  // 第一轮给一条 update，之后队列空（连续轮询不炸）
  const { server, seen } = fakeTelegram([[{ ...update, update_id: 200, message: { ...update.message, text: "/start" } }]]);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;
  const client = new TelegramClient({ token: "fake", baseUrl: `http://127.0.0.1:${port}` });
  const connector = new TelegramConnector({
    kernel: new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-tg-loop-")), chart: mockChart }),
    log: () => {},
  });
  connector.attachClient(client);
  const poll = startTelegramPolling({ client, connector, log: () => {}, intervalMs: 50 });
  await sleep(400);
  poll.stop();
  const created = connector["opts"].kernel.store.allEvents().filter((e) => e.kind === "task.created");
  assert.equal(created.length, 0, "/start 是控制面命令，不建任务");
  assert.ok(seen.length >= 2, "循环应至少轮询两轮");
  server.close();
});

test("去重与解析：同 update 只建一次任务；edited_message 与斜杠命令忽略", () => {
  const connector = new TelegramConnector({
    kernel: new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-tg-dedup-")), chart: mockChart }),
  });
  connector.handleUpdate(update);
  connector.handleUpdate(update); // 重放
  let created = connector["opts"].kernel.store.allEvents().filter((e) => e.kind === "task.created");
  assert.equal(created.length, 1, "重复 update 应去重");

  connector.handleUpdate({ update_id: 101, edited_message: { text: "编辑" } });
  connector.handleUpdate({ update_id: 102, message: { message_id: 2, chat: { id: 1 }, text: "/status" } });
  created = connector["opts"].kernel.store.allEvents().filter((e) => e.kind === "task.created");
  assert.equal(created.length, 1, "编辑消息与斜杠命令都不建任务");

  assert.equal(parseTelegramUpdate({ update_id: 103, message: { chat: { id: 1 }, text: "  " } }), null, "空白文本忽略");
});
