import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import { HiveKernel } from "@hive/kernel";
import { DiscordConnector, DiscordClient, startDiscordGateway, parseDiscordMessage } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(here, "../../../..");
const mockChart = JSON.parse(readFileSync(join(hiveRoot, "teams/mock-team.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 测试用最小 WS 实现：包一层 ws.WebSocket，满足 MinimalWebSocket 接口 */
class TestWS extends WebSocket {
  send(data: string): void {
    super.send(data);
  }
}

test("Discord 解析：bot 自发/斜杠/非文本忽略，正常文本通过", () => {
  assert.equal(
    parseDiscordMessage({ id: "1", channel_id: "c1", author: { id: "u1", bot: true }, content: "hi" }),
    null,
    "bot 自发忽略",
  );
  assert.equal(parseDiscordMessage({ id: "2", channel_id: "c1", author: { id: "u1" }, content: "/status" }), null, "斜杠忽略");
  assert.equal(parseDiscordMessage({ id: "3", channel_id: "c1", author: { id: "u1" }, content: "  " }), null, "空白忽略");
  const ok = parseDiscordMessage({ id: "4", channel_id: "c2", author: { id: "u2" }, content: "调研并出简报" });
  assert.ok(ok);
  assert.equal(ok.chatId, "c2");
});

test("Discord E2E：gateway MESSAGE_CREATE → 建任务 → mock 团队跑完 → REST 回帖", async () => {
    // 1) 假 gateway WS 服务器：推 Hello(op10) → 收 Identify(op2) → 推 MESSAGE_CREATE(op0)
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((res) => wss.once("listening", () => res()));
  const gwPort = (wss.address() as AddressInfo).port;
  let identified = 0;
  wss.on("connection", (socket) => {
    console.log("[gw] hello sent");
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on("message", (raw) => {
      const payload = JSON.parse(String(raw)) as { op: number; d?: { token?: string } };
      if (payload.op === 2) {
        identified += 1;
        console.log("[gw] identified");
        assert.equal(payload.d?.token, "fake-discord-token", "identify 应带 bot token");
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              op: 0,
              t: "MESSAGE_CREATE",
              d: { id: "m1", channel_id: "c777", author: { id: "u42" }, content: "调研竞品并出简报" },
            }),
          );
        }, 50);
      }
    });
  });

  // 2) 假 REST 服务器：记录 sendMessage
  const sent: { path: string; content: string }[] = [];
  const rest = createServer((req, res) => {
    let body = "";
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      sent.push({ path: req.url ?? "", content: (JSON.parse(body || "{}").content as string) ?? "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg-1" }));
    });
  });
  rest.listen(0, "127.0.0.1", () => console.log("[e2e] rest listening, port=", (rest.address() as AddressInfo)?.port));
  await new Promise<void>((res) => rest.once("listening", () => res()));
  const restPort = (rest.address() as AddressInfo).port;

  const client = new DiscordClient({
    token: "fake-discord-token",
    restBaseUrl: `http://127.0.0.1:${restPort}`,
    gatewayUrl: `ws://127.0.0.1:${gwPort}`,
  });
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-dc-")), chart: mockChart });
  const connector = new DiscordConnector({ kernel, log: () => {} }, client);
  console.log("[e2e] starting gateway");
  const handle = startDiscordGateway({ client, connector, log: (m) => console.log("[conn]", m), WsImpl: TestWS as never });

  // 等任务跑完并回帖（最长 5s）
  for (let i = 0; i < 50 && (client.sent.length === 0 || kernel.store.allEvents().filter((e) => e.kind === "task.status_changed").length === 0); i++) await sleep(100);
  console.log("[e2e] wait done, sent=", client.sent.length, "events=", kernel.store.allEvents().filter((e) => e.kind === "task.created").length, "+ status=", kernel.store.allEvents().filter((e) => e.kind === "task.status_changed").map((e) => (e.payload as { to?: string }).to).join(","));

  assert.ok(identified >= 1, "gateway 应完成 identify");
  assert.equal(client.sent.length, 1, "终态应回帖一次");
  assert.equal(client.sent[0].chatId, "c777");
  assert.match(client.sent[0].text, /✅ 蜂巢 · 任务 #1/);
  assert.match(client.sent[0].text, /花费：\$/);
  assert.match(sent[0].path, /\/channels\/c777\/messages/, "REST 路径正确");
  assert.match(sent[0].content, /蜂巢 · 任务 #1/, "REST 内容正确");

  handle.stop();
  wss.close();
  rest.close();
});

test('Discord 去重：同 message.id 只建一次任务', async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), 'hive-dc-dedup-')), chart: mockChart });
  const connector = new DiscordConnector({ kernel });
  const dispatch = { t: 'MESSAGE_CREATE', d: { id: 'm1', channel_id: 'c1', author: { id: 'u1' }, content: '干活' } };
  connector.handleDispatch(dispatch);
  connector.handleDispatch(dispatch);
  const created = () => kernel.store.allEvents().filter((e) => e.kind === 'task.created');
  for (let i = 0; i < 20 && created().length === 0; i++) await sleep(50);
  assert.equal(created().length, 1, '重复消息应去重');

  connector.handleDispatch({ t: 'MESSAGE_CREATE', d: { id: 'm2', channel_id: 'c1', author: { id: 'u1', bot: true }, content: 'bot 自发' } });
  connector.handleDispatch({ t: 'MESSAGE_CREATE', d: { id: 'm3', channel_id: 'c1', author: { id: 'u1' }, content: '/status' } });
  connector.handleDispatch({ t: 'MESSAGE_UPDATE', d: {} });
  for (let i = 0; i < 10 && created().length > 1; i++) await sleep(50);
  assert.equal(created().length, 1, 'bot 自发/斜杠/非 MESSAGE_CREATE 都不建任务');
  assert.equal(parseDiscordMessage({ id: 'm4', channel_id: 'c1', author: { id: 'u1' }, content: '  ' }), null, '空白忽略');
});
