import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HiveKernel } from "@hive/kernel";
import { WeComConnector, WeComClient, wecomDecrypt, wecomEncrypt, wecomSignature, parseWecomPlaintext } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const hiveRoot = join(here, "../../../..");
const mockChart = JSON.parse(readFileSync(join(hiveRoot, "teams/mock-team.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 43 字符测试 EncodingAESKey（官方要求：a-zA-Z0-9 共 43 字符）
const AES_KEY = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const TOKEN = "hive-test-token";
const CORP_ID = "ww-test-corp";

test("企微 crypto：加解密回环（明文结构 16B 随机 + 4B 长度 + msg + receiveid）+ 签名字典序", () => {
  const msg = "<xml><FromUserName><![CDATA[u1]]></FromUserName><Content><![CDATA[hi]]></Content></xml>";
  const enc = wecomEncrypt(msg, CORP_ID, AES_KEY);
  const { msg: plain, receiveid } = wecomDecrypt(enc, AES_KEY);
  assert.equal(plain, msg, "加解密回环一致");
  assert.equal(receiveid, CORP_ID, "receiveid = corpid");

  // 签名：字典序排序后 sha1——手工构造验证
  const s = wecomSignature(TOKEN, "123", "n", "e");
  assert.equal(s, wecomSignature("e", TOKEN, "123", "n"), "参数顺序无关（内部字典序）");
  assert.match(s, /^[0-9a-f]{40}$/, "sha1 全小写 hex");
});

test("企微解析：XML 与 JSON 两种明文通吃；非文本/斜杠/空忽略", () => {
  const xml = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName><FromUserName><![CDATA[u1]]></FromUserName><CreateTime>123</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[调研并出简报]]></Content><MsgId>9001</MsgId><AgentID><![CDATA[1000002]]></AgentID></xml>`;
  const fromXml = parseWecomPlaintext(xml);
  assert.ok(fromXml);
  assert.equal(fromXml.msgId, "9001");
  assert.equal(fromXml.fromUser, "u1");
  assert.equal(fromXml.text, "调研并出简报");
  assert.equal(fromXml.agentId, "1000002");

  const fromJson = parseWecomPlaintext(JSON.stringify({ fromusername: "u2", msgtype: "text", content: "干活", msgid: 9002, agentid: 1000002 }));
  assert.ok(fromJson);
  assert.equal(fromJson.msgId, "9002");

  assert.equal(parseWecomPlaintext("<xml><MsgType><![CDATA[image]]></MsgType></xml>"), null, "非文本忽略");
  assert.equal(parseWecomPlaintext("<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/status]]></Content><FromUserName><![CDATA[u1]]></FromUserName></xml>"), null, "斜杠忽略");
});

async function makeKernel(): Promise<{ kernel: HiveKernel; connector: WeComConnector; client: WeComClient; stop: () => Promise<void> }> {
  // 假企微 REST：gettoken + message/send
  const sent: { path: string; touser?: string; agentid?: number; content?: string }[] = [];
  const rest = createServer((req, res) => {
    let body = "";
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/cgi-bin/gettoken")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "at-1", expires_in: 7200 }));
        return;
      }
      if (req.url?.startsWith("/cgi-bin/message/send")) {
        const doc = JSON.parse(body || "{}") as { touser?: string; agentid?: number; text?: { content?: string } };
        sent.push({ path: req.url, touser: doc.touser, agentid: doc.agentid, content: doc.text?.content });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
  });
  rest.listen(0, "127.0.0.1", () => {});
  await new Promise<void>((res) => rest.once("listening", () => res()));
  const restPort = (rest.address() as AddressInfo).port;
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-wecom-")), chart: mockChart });
  const client = new WeComClient({ corpId: CORP_ID, corpSecret: "s", baseUrl: `http://127.0.0.1:${restPort}` });
  const connector = new WeComConnector({ kernel, token: TOKEN, encodingAesKey: AES_KEY, corpId: CORP_ID, log: () => {} }, client);
  return {
    kernel,
    connector,
    client,
    stop: async () => {
      rest.close();
    },
  };
}

test("企微 E2E：URL 验证（echostr 明文回显）→ 加密回调 → 建任务 → mock 跑完 → message/send 回帖", async () => {
  const { kernel, connector, client, stop } = await makeKernel();
  try {
    // 1) URL 验证：签名正确 → 解密 echostr 原样返回；签名错 → 403
    const echo = "verify-me";
    const encEcho = wecomEncrypt(echo, CORP_ID, AES_KEY);
    const sigEcho = wecomSignature(TOKEN, "123", "n1", encEcho);
    const ok = connector.handleVerifyUrl({ msg_signature: sigEcho, timestamp: "123", nonce: "n1", echostr: encEcho });
    assert.equal(ok.status, 200);
    assert.equal(ok.reply, echo, "echostr 明文原样返回");
    const bad = connector.handleVerifyUrl({ msg_signature: "deadbeef", timestamp: "123", nonce: "n1", echostr: encEcho });
    assert.equal(bad.status, 403, "签名错 → 403 不发 echostr");

    // 2) 加密回调（JSON body）→ 建任务 → mock 跑完 → 回帖
    const plaintext = `<xml><FromUserName><![CDATA[u42]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[调研竞品并出简报]]></Content><MsgId>90042</MsgId><AgentID>1000002</AgentID></xml>`;
    const enc = wecomEncrypt(plaintext, CORP_ID, AES_KEY);
    const sig = wecomSignature(TOKEN, "123", "n2", enc);
    const cb = connector.handleCallback({ msg_signature: sig, timestamp: "123", nonce: "n2", body: JSON.stringify({ tousername: CORP_ID, encrypt: enc, agentid: 1000002 }) });
    assert.equal(cb.status, 200, "回调 200 已接收");

    const badCb = connector.handleCallback({ msg_signature: "deadbeef", timestamp: "123", nonce: "n2", body: JSON.stringify({ encrypt: enc }) });
    assert.equal(badCb.status, 403, "回调验签失败 → 403 不建任务");

    for (let i = 0; i < 50 && client.sent.length === 0; i++) await sleep(100);
    assert.equal(client.sent.length, 1, "终态应回帖一次");
    assert.equal(client.sent[0].toUser, "u42");
    assert.match(client.sent[0].text, /✅ 蜂巢 · 任务 #1/);
    assert.match(client.sent[0].text, /花费：\$/);
  } finally {
    await stop();
  }
});

test("企微去重：同 MsgId 重推只建一次任务", async () => {
  const { kernel, connector, stop } = await makeKernel();
  try {
    const plaintext = `<xml><FromUserName><![CDATA[u1]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[干活]]></Content><MsgId>91001</MsgId><AgentID>1</AgentID></xml>`;
    const enc = wecomEncrypt(plaintext, CORP_ID, AES_KEY);
    const sig = wecomSignature(TOKEN, "123", "n", enc);
    const cb = { msg_signature: sig, timestamp: "123", nonce: "n", body: JSON.stringify({ encrypt: enc }) };
    connector.handleCallback(cb);
    connector.handleCallback(cb); // 企微重推：同密文同签名
    const created = () => kernel.store.allEvents().filter((e) => e.kind === "task.created");
    for (let i = 0; i < 20 && created().length === 0; i++) await sleep(50);
    assert.equal(created().length, 1, "重复消息应去重");
  } finally {
    await stop();
  }
});
