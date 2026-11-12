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
import { SlackConnector, SlackClient, startSlackSocket, parseSlackEventCallback } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(here, "../../../..");
const mockChart = JSON.parse(readFileSync(join(hiveRoot, "teams/mock-team.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 测试用最小 WS 实现：包一层 ws.WebSocket，满足 MinimalWebSocket 接口 */
class TestWS extends WebSocket {}

test("Slack 解析：bot 自发/subtype/斜杠/非 event_callback 忽略，正常文本通过", () => {
  const ev = (event: Record<string, unknown>) => ({ type: "event_callback", event_id: "Ev1", event });
  assert.equal(parseSlackEventCallback(ev({ type: "message", channel: "c1", user: "u1", bot_id: "B1", text: "hi" })), null, "bot 自发忽略");
  assert.equal(parseSlackEventCallback(ev({ type: "message", channel: "c1", user: "u1", text: "/status" })), null, "斜杠忽略");
  assert.equal(parseSlackEventCallback(ev({ type: "message", channel: "c1", user: "u1", text: "  " })), null, "空白忽略");
  assert.equal(parseSlackEventCallback(ev({ type: "message", channel: "c1", user: "u1", subtype: "message_changed", text: "改" })), null, "subtype 忽略");
  assert.equal(parseSlackEventCallback({ type: "other", event_id: "Ev2" }), null, "非 event_callback 忽略");
  const ok = parseSlackEventCallback(ev({ type: "app_mention", channel: "c2", user: "u2", text: "调研并出简报" }));
  assert.ok(ok);
  assert.equal(ok.chatId, "c2");
  assert.equal(ok.eventId, "Ev1");
});

test("Slack E2E：Socket Mode 信封 → ack → 建任务 → mock 团队跑完 → chat.postMessage 回帖", async () => {
  // 1) 假 Socket Mode WS 服务器：hello → ping → events_api 信封
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((res) => wss.once("listening", () => res()));
  const wsPort = (wss.address() as AddressInfo).port;
  const acks: string[] = [];
  let ponged = false;
  let envelopeSent = false;
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello" }));
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { envelope_id?: string; type?: string };
      if (msg.envelope_id) acks.push(msg.envelope_id);
      if (msg.type === "pong") ponged = true;
    });
    socket.send(JSON.stringify({ type: "ping" }));
    setTimeout(() => {
      envelopeSent = true;
      socket.send(
        JSON.stringify({
          type: "events_api",
          envelope_id: "env-1",
          payload: { type: "event_callback", event_id: "Ev42", event: { type: "message", channel: "C777", user: "U42", text: "调研竞品并出简报" } },
        }),
      );
    }, 50);
  });

  // 2) 假 REST 服务器：记录 chat.postMessage
  const sent: { path: string; channel: string; text: string }[] = [];
  const rest = createServer((req, res) => {
    let body = "";
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const doc = JSON.parse(body || "{}") as { channel?: string; text?: string };
      sent.push({ path: req.url ?? "", channel: doc.channel ?? "", text: doc.text ?? "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: "1" }));
    });
  });
  rest.listen(0, "127.0.0.1", () => {});
  await new Promise<void>((res) => rest.once("listening", () => res()));
  const restPort = (rest.address() as AddressInfo).port;

  const client = new SlackClient({
    botToken: "xoxb-fake",
    appToken: "xapp-fake",
    restBaseUrl: `http://127.0.0.1:${restPort}`,
    socketBaseUrl: `ws://127.0.0.1:${wsPort}`,
  });
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-slack-")), chart: mockChart });
  const connector = new SlackConnector({ kernel, log: () => {} }, client);
  const handle = startSlackSocket({ client, connector, log: () => {}, WsImpl: TestWS as never });

  for (let i = 0; i < 50 && (client.sent.length === 0 || acks.length === 0); i++) await sleep(100);

  assert.ok(envelopeSent, "信封应已投递");
  assert.ok(ponged, "ping 应回 pong");
  assert.ok(acks.includes("env-1"), "信封必须 ack（协议强制）");
  assert.equal(client.sent.length, 1, "终态应回帖一次");
  assert.equal(client.sent[0].chatId, "C777");
  assert.match(client.sent[0].text, /✅ 蜂巢 · 任务 #1/);
  assert.match(client.sent[0].text, /花费：\$/);
  assert.equal(sent[0].path, "/chat.postMessage", "REST 路径正确");
  assert.equal(sent[0].channel, "C777", "REST 频道正确");
  assert.match(sent[0].text, /蜂巢 · 任务 #1/, "REST 内容正确");

  handle.stop();
  wss.close();
  rest.close();
});

test("Slack 去重：同 event_id 只建一次任务（重投兜底）", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-slack-dedup-")), chart: mockChart });
  const connector = new SlackConnector({ kernel });
  const envelope = {
    type: "events_api",
    envelope_id: "env-1",
    payload: { type: "event_callback", event_id: "Ev1", event: { type: "message", channel: "c1", user: "u1", text: "干活" } },
  };
  connector.handleEnvelope(envelope);
  connector.handleEnvelope({ ...envelope, envelope_id: "env-2" }); // Slack 重投：同 event_id 新信封
  const created = () => kernel.store.allEvents().filter((e) => e.kind === "task.created");
  for (let i = 0; i < 20 && created().length === 0; i++) await sleep(50);
  assert.equal(created().length, 1, "重复事件应去重");

  connector.handleEnvelope({ type: "events_api", envelope_id: "env-3", payload: { type: "event_callback", event_id: "Ev2", event: { type: "message", channel: "c1", user: "u1", bot_id: "B1", text: "bot 自发" } } });
  connector.handleEnvelope({ type: "events_api", envelope_id: "env-4", payload: { type: "event_callback", event_id: "Ev3", event: { type: "message", channel: "c1", user: "u1", text: "/status" } } });
  connector.handleEnvelope({ type: "interactive", envelope_id: "env-5", payload: {} });
  for (let i = 0; i < 10 && created().length > 1; i++) await sleep(50);
  assert.equal(created().length, 1, "bot 自发/斜杠/非 events_api 都不建任务");
  assert.equal(parseSlackEventCallback({ type: "event_callback", event_id: "Ev4", event: { type: "message", channel: "c1", user: "u1", text: "  " } }), null, "空白忽略");
});
