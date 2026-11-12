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
import { DingTalkConnector, DingTalkClient, startDingTalkStream, parseDingTalkEvent } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(here, "../../../..");
const mockChart = JSON.parse(readFileSync(join(hiveRoot, "teams/mock-team.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("钉钉解析：topic 不符/非文本/斜杠/坏 data 忽略，单聊群聊文本通过", () => {
  const frame = (topic: string, data: unknown) => ({
    type: "EVENT",
    headers: { topic, messageId: "M1" },
    data: typeof data === "string" ? data : JSON.stringify(data),
  });
  const msg = {
    conversationType: "2",
    conversationId: "cid1",
    senderStaffId: "u1",
    robotCode: "rk1",
    text: { content: "调研并出简报" },
  };
  assert.equal(parseDingTalkEvent(frame("/v1.0/callbacks/other", msg)), null, "topic 不符忽略");
  assert.equal(parseDingTalkEvent(frame("/v1.0/im/bot/messages/get", { ...msg, text: { content: "  " } })), null, "空白忽略");
  assert.equal(parseDingTalkEvent(frame("/v1.0/im/bot/messages/get", { ...msg, text: { content: "/status" } })), null, "斜杠忽略");
  assert.equal(parseDingTalkEvent(frame("/v1.0/im/bot/messages/get", "不是 json")), null, "坏 data 忽略");
  const ok = parseDingTalkEvent(frame("/v1.0/im/bot/messages/get", msg));
  assert.ok(ok);
  assert.equal(ok.chatId, "cid1", "群聊 chatId = openConversationId");
  assert.equal(ok.robotCode, "rk1");
  const single = parseDingTalkEvent(frame("/v1.0/im/bot/messages/get", { ...msg, conversationType: "1" }));
  assert.ok(single);
  assert.equal(single.chatId, "u1", "单聊 chatId = senderId（回复走 oToMessages）");
});

test("钉钉 E2E：Stream EVENT 帧 → ACK(code 200) → 建任务 → mock 团队跑完 → 群聊 REST 回帖", async () => {
  // 1) 假 API 服务器：connections/open + accessToken + groupMessages/send
  const rest = createServer((req, res) => {
    let body = "";
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1.0/gateway/connections/open") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ endpoint: `ws://127.0.0.1:${wsPort}`, ticket: "tkt-1" }));
        return;
      }
      if (req.url === "/v1.0/oauth2/accessToken") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accessToken: "at-1", expireIn: 7200 }));
        return;
      }
      if (req.url === "/v1.0/robot/groupMessages/send") {
        const doc = JSON.parse(body || "{}") as { robotCode?: string; openConversationId?: string; msgParam?: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ robotCode: doc.robotCode, openConversationId: doc.openConversationId, msgParam: doc.msgParam }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  rest.listen(0, "127.0.0.1", () => {});
  await new Promise<void>((res) => rest.once("listening", () => res()));
  const restPort = (rest.address() as AddressInfo).port;

  // 2) 假 Stream WS 服务器：推 EVENT 帧，收 ACK
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((res) => wss.once("listening", () => res()));
  const wsPort = (wss.address() as AddressInfo).port;
  const acks: Array<{ code: number; messageId?: string; topic?: string }> = [];
  wss.on("connection", (socket) => {
    setTimeout(() => {
      socket.send(
        JSON.stringify({
          type: "EVENT",
          headers: { topic: "/v1.0/im/bot/messages/get", messageId: "M42" },
          data: JSON.stringify({ conversationType: "2", conversationId: "cid777", senderStaffId: "u42", robotCode: "rk1", text: { content: "调研竞品并出简报" } }),
        }),
      );
    }, 50);
    socket.on("message", (raw) => {
      const ack = JSON.parse(String(raw)) as { code?: number; headers?: { messageId?: string; topic?: string } };
      acks.push({ code: ack.code ?? 0, messageId: ack.headers?.messageId, topic: ack.headers?.topic });
    });
  });

  const client = new DingTalkClient({
    appKey: "fake-key",
    appSecret: "fake-secret",
    apiBaseUrl: `http://127.0.0.1:${restPort}`,
  });
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-dt-")), chart: mockChart });
  const connector = new DingTalkConnector({ kernel, log: () => {} }, client);
  const handle = await startDingTalkStream({ client, connector, log: () => {}, WsImpl: WebSocket as never });

  for (let i = 0; i < 50 && (client.sent.length === 0 || acks.length === 0); i++) await sleep(100);

  assert.ok(acks.length >= 1, "EVENT 帧必须 ACK");
  assert.equal(acks[0].code, 200, "ACK code 200");
  assert.equal(acks[0].messageId, "M42", "ACK echo messageId");
  assert.equal(acks[0].topic, "/v1.0/im/bot/messages/get", "ACK echo topic");
  assert.equal(client.sent.length, 1, "终态应回帖一次");
  assert.equal(client.sent[0].target.conversationType, "2");
  assert.equal(client.sent[0].target.chatId, "cid777");
  assert.equal(client.sent[0].target.robotCode, "rk1");
  assert.match(client.sent[0].text, /✅ 蜂巢 · 任务 #1/);
  assert.match(client.sent[0].text, /花费：\$/);

  handle.stop();
  wss.close();
  rest.close();
});

test("钉钉去重：同 messageId 只建一次任务（重投兜底）", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-dt-dedup-")), chart: mockChart });
  const connector = new DingTalkConnector({ kernel });
  const frame = (id: string, data: Record<string, unknown>) => ({
    type: "EVENT",
    headers: { topic: "/v1.0/im/bot/messages/get", messageId: id },
    data: JSON.stringify(data),
  });
  const msg = { conversationType: "2", conversationId: "c1", senderStaffId: "u1", robotCode: "rk1", text: { content: "干活" } };
  connector.handleEvent(frame("M1", msg));
  connector.handleEvent(frame("M1", msg)); // 重投同 messageId
  const created = () => kernel.store.allEvents().filter((e) => e.kind === "task.created");
  for (let i = 0; i < 20 && created().length === 0; i++) await sleep(50);
  assert.equal(created().length, 1, "重复消息应去重");

  connector.handleEvent(frame("M2", { ...msg, text: { content: "/status" } }));
  connector.handleEvent({ type: "SYSTEM", headers: { topic: "disconnect", messageId: "M3" }, data: "{}" });
  for (let i = 0; i < 10 && created().length > 1; i++) await sleep(50);
  assert.equal(created().length, 1, "斜杠/系统帧不建任务");
});
