import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { HiveKernel } from "@hive/kernel";
import { FeishuConnector, FeishuClient, encryptLark, decryptLark, larkSignature } from "../index.js";

const hiveRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams/mock-team.json"), "utf8"));
const KEY = "hive-test-encrypt-key";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs: number, stepMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await sleep(stepMs);
  }
}

interface FakeFeishu {
  port: number;
  sent: Array<{ chatId: string; text: string; auth?: string }>;
  tokenHits: number;
  close(): Promise<void>;
}

/** 假飞书服务器：tenant_access_token + 发消息两个端点，全部记录观测 */
function startFakeFeishu(): Promise<FakeFeishu> {
  const state: FakeFeishu = {
    port: 0,
    sent: [],
    tokenHits: 0,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
        state.tokenHits += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, tenant_access_token: "t-fake", expire: 7200 }));
        return;
      }
      if (req.url?.startsWith("/open-apis/im/v1/messages")) {
        const doc = JSON.parse(body) as { receive_id: string; content: string };
        state.sent.push({
          chatId: doc.receive_id,
          text: String(JSON.parse(doc.content).text ?? ""),
          auth: req.headers.authorization,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 0, data: { message_id: "om_fake" } }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

function imEvent(eventId: string, chatId: string, text: string, messageType = "text"): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { event_id: eventId, event_type: "im.message.receive_v1", token: "vtoken", create_time: String(Date.now()) },
    event: {
      sender: { sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: `om_${eventId}`,
        message_type: messageType,
        chat_id: chatId,
        content: JSON.stringify({ text }),
      },
    },
  };
}

function signedEncryptedRequest(inner: Record<string, unknown>, key: string) {
  const enc = encryptLark(JSON.stringify(inner), key);
  const raw = JSON.stringify({ encrypt: enc });
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = "n123";
  return { raw, headers: { signature: larkSignature(ts, nonce, key, raw), timestamp: ts, nonce } };
}

test("crypto：加解密对称 + 签名匹配/不匹配", () => {
  const plain = JSON.stringify({ hello: "蜂巢", n: 42 });
  const enc = encryptLark(plain, KEY);
  assert.equal(decryptLark(enc, KEY), plain);
  const sig = larkSignature("1", "a", KEY, "body");
  assert.equal(larkSignature("1", "a", KEY, "body"), sig);
  assert.notEqual(larkSignature("2", "a", KEY, "body"), sig, "时间戳变了签名必须变");
});

test("url_verification：明文与密文两种 challenge 回显", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-fs-")), chart });
  const connector = new FeishuConnector({ kernel, client: null, encryptKey: KEY });

  const plain = await connector.handleCallback(JSON.stringify({ type: "url_verification", challenge: "c-plain" }));
  assert.equal(plain.status, 200);
  assert.equal((plain.body as { challenge: string }).challenge, "c-plain");

  const { raw, headers } = signedEncryptedRequest({ type: "url_verification", challenge: "c-enc" }, KEY);
  const encRes = await connector.handleCallback(raw, headers);
  assert.equal(encRes.status, 200);
  assert.equal((encRes.body as { challenge: string }).challenge, "c-enc", "加密的 challenge 解密后回显");
  connector.close();
});

test("闭环：飞书发一句话 → 建任务自动跑 → ✅ 回帖带账单", async () => {
  const feishu = await startFakeFeishu();
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-fs-loop-")), chart });
  const client = new FeishuClient({ appId: "cli_x", appSecret: "sec", baseUrl: `http://127.0.0.1:${feishu.port}` });
  const connector = new FeishuConnector({ kernel, client, encryptKey: KEY, defaultBudgetUsd: 5 });

  try {
    const inner = imEvent("evt-1", "oc_demo", "写一份竞品研究简报");
    const { raw, headers } = signedEncryptedRequest(inner, KEY);
    const res = await connector.handleCallback(raw, headers);
    assert.equal(res.status, 200);

    // 任务建立且来源可回溯（重启后也能从事件流找回回帖目标）
    const created = kernel.store.allEvents().find((e) => e.kind === "task.created");
    assert.ok(created);
    assert.equal((created!.payload as { brief: string }).brief, "写一份竞品研究简报");
    assert.match((created!.payload as { source: string }).source, /^feishu:oc_demo:ou_sender/);

    // 等任务跑完 → 回帖到达假飞书
    const sent = await waitUntil(() => feishu.sent.find((s) => s.chatId === "oc_demo"), 15000);
    assert.ok(sent, "任务完成后应回帖到来源群");
    assert.match(sent!.text, /✅/);
    assert.match(sent!.text, /任务 #1/);
    assert.match(sent!.text, /\$0\.50/, "回帖应带账单金额");
    assert.match(sent!.auth ?? "", /Bearer t-fake/);
    assert.equal(feishu.tokenHits, 1, "token 应缓存复用");
  } finally {
    connector.close();
    await feishu.close();
  }
});

test("去重：同一 event_id 重推只建一个任务", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-fs-dedup-")), chart });
  const connector = new FeishuConnector({ kernel, client: null, encryptKey: KEY });
  try {
    const inner = imEvent("evt-dup", "oc_x", "重复推送测试");
    const { raw, headers } = signedEncryptedRequest(inner, KEY);
    await connector.handleCallback(raw, headers);
    await connector.handleCallback(raw, headers);
    await connector.handleCallback(raw, headers);
    assert.equal(kernel.store.countKind("task.created"), 1, "三次推送只建一个任务");
  } finally {
    connector.close();
  }
});

test("门禁：签名不匹配 → 403，不建任务", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-fs-sig-")), chart });
  const connector = new FeishuConnector({ kernel, client: null, encryptKey: KEY });
  try {
    const inner = imEvent("evt-bad-sig", "oc_x", "恶意请求");
    const { raw } = signedEncryptedRequest(inner, KEY);
    const res = await connector.handleCallback(raw, { signature: "bad", timestamp: "1", nonce: "n" });
    assert.equal(res.status, 403);
    assert.equal(kernel.store.countKind("task.created"), 0);
  } finally {
    connector.close();
  }
});

test("非文本消息（image）→ 200 吞掉不建任务", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-fs-img-")), chart });
  const connector = new FeishuConnector({ kernel, client: null, encryptKey: KEY });
  try {
    const inner = imEvent("evt-img", "oc_x", "", "image");
    const { raw, headers } = signedEncryptedRequest(inner, KEY);
    const res = await connector.handleCallback(raw, headers);
    assert.equal(res.status, 200);
    assert.equal(kernel.store.countKind("task.created"), 0);
  } finally {
    connector.close();
  }
});

test("长连接路径：handleEventObject 明文事件直连（去重 + 建任务）", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-fs-ws-")), chart });
  const connector = new FeishuConnector({ kernel, client: null, encryptKey: KEY });
  try {
    // SDK 分发的就是 {schema, header, event} 明文对象——与 webhook 解密后同构
    await connector.handleEventObject(imEvent("evt-ws-1", "oc_ws", "长连接建任务测试"));
    await connector.handleEventObject(imEvent("evt-ws-1", "oc_ws", "长连接建任务测试")); // 同 event_id 重推
    assert.equal(kernel.store.countKind("task.created"), 1, "长连接路径去重同样生效");
    const created = kernel.store.allEvents().find((e) => e.kind === "task.created");
    assert.match((created!.payload as { source: string }).source, /^feishu:oc_ws:/);
  } finally {
    connector.close();
  }
});

test("FeishuClient 单测：token 缓存 + 消息发送", async () => {
  const feishu = await startFakeFeishu();
  const client = new FeishuClient({ appId: "a", appSecret: "b", baseUrl: `http://127.0.0.1:${feishu.port}` });
  try {
    await client.sendMessage("oc_1", "第一条");
    await client.sendMessage("oc_2", "第二条");
    assert.equal(feishu.tokenHits, 1, "两次发消息只取一次 token");
    assert.equal(feishu.sent.length, 2);
    assert.equal(feishu.sent[1]!.chatId, "oc_2");
  } finally {
    await feishu.close();
  }
});
