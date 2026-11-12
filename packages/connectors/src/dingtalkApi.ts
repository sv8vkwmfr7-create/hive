/**
 * 钉钉 API 客户端：REST（accessToken + 机器人消息发送）+ Stream Mode 收事件。
 * Stream Mode 免公网：POST gateway/connections/open 拿 endpoint+ticket → WS 连接即握手；
 * 帧格式 {type, headers:{topic,messageId}, data:"<json 字符串>"}，EVENT 帧必须回 ACK（code 200 + echo）。
 * apiBaseUrl/socketEndpoint 可注入——离线测试指向假服务器，凭据到位后零改动切官方端点。
 */
export interface DingTalkClientOptions {
  appKey: string;
  appSecret: string;
  /** 默认 https://api.dingtalk.com */
  apiBaseUrl?: string;
  /** 测试注入：openConnection 直接返回该 endpoint（跳过 connections/open） */
  socketEndpoint?: string;
}

export class DingTalkError extends Error {}

export interface DingTalkEventFrame {
  type: string;
  headers: { topic: string; messageId: string; contentType?: string };
  /** wire 上是 JSON 字符串（官方 SDK from_dict 证实），解析后为对象 */
  data: string;
}

export interface DingTalkConnection {
  endpoint: string;
  ticket: string;
}

export interface StreamWebSocket {
  send(data: string): void;
  close(): void;
  /** 协议级心跳：生产实现（ws 包）必备，钉钉会断开不发 ping 的连接 */
  ping?(): void;
  on(event: "message", cb: (raw: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}
export interface StreamWebSocketCtor {
  new (url: string): StreamWebSocket;
}

export interface DingTalkHandle {
  stop: () => void;
}

/** 机器人消息的回复寻址（source 落盘，重启可找回；sessionWebhook 带临时凭据绝不落盘） */
export interface DingTalkReplyTarget {
  /** 1 = 单聊（oToMessages），2 = 群聊（groupMessages） */
  conversationType: "1" | "2";
  /** 单聊 = senderId（userId），群聊 = openConversationId */
  chatId: string;
  robotCode: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class DingTalkClient {
  /** 测试观测点：发出的消息 */
  sent: Array<{ target: DingTalkReplyTarget; text: string }> = [];
  private token: CachedToken | null = null;

  constructor(private opts: DingTalkClientOptions) {}

  private api(): string {
    return (this.opts.apiBaseUrl ?? "https://api.dingtalk.com").replace(/\/$/, "");
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await fetch(`${this.api()}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: this.opts.appKey, appSecret: this.opts.appSecret }),
    });
    const doc = (await res.json()) as { accessToken?: string; expireIn?: number };
    if (!res.ok || !doc.accessToken) throw new DingTalkError(`accessToken 获取失败：${res.status} ${JSON.stringify(doc).slice(0, 200)}`);
    // 提前 60s 过期，避免临界点撞 token 失效
    this.token = { value: doc.accessToken, expiresAt: Date.now() + Math.max(60_000, (doc.expireIn ?? 7200) * 1000 - 60_000) };
    return this.token.value;
  }

  /** Stream Mode 建连：endpoint + ticket（ticket 即认证，WS 连上即完成握手） */
  async openConnection(): Promise<DingTalkConnection> {
    if (this.opts.socketEndpoint) return { endpoint: this.opts.socketEndpoint, ticket: "test-ticket" };
    const res = await fetch(`${this.api()}/v1.0/gateway/connections/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: this.opts.appKey,
        clientSecret: this.opts.appSecret,
        subscriptions: [{ type: "EVENT", topic: "/v1.0/im/bot/messages/get" }],
        ua: "hive-connector/0.1",
        localIp: "127.0.0.1",
      }),
    });
    const doc = (await res.json()) as { endpoint?: string; ticket?: string };
    if (!res.ok || !doc.endpoint || !doc.ticket) {
      throw new DingTalkError(`connections/open 失败：${res.status} ${JSON.stringify(doc).slice(0, 200)}`);
    }
    return { endpoint: doc.endpoint, ticket: doc.ticket };
  }

  /** 机器人回复：单聊 oToMessages / 群聊 groupMessages（sampleText 消息模板） */
  async sendMessage(target: DingTalkReplyTarget, text: string): Promise<void> {
    const accessToken = await this.ensureAccessToken();
    const isGroup = target.conversationType === "2";
    const path = isGroup ? "/v1.0/robot/groupMessages/send" : "/v1.0/robot/oToMessages/batchSend";
    const body = isGroup
      ? { robotCode: target.robotCode, openConversationId: target.chatId, msgKey: "sampleText", msgParam: JSON.stringify({ content: text }) }
      : { robotCode: target.robotCode, userIds: [target.chatId], msgKey: "sampleText", msgParam: JSON.stringify({ content: text }) };
    const res = await fetch(`${this.api()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": accessToken },
      body: JSON.stringify(body),
    });
    const doc = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new DingTalkError(`sendMessage 失败：${res.status} ${doc.message ?? ""}`);
    this.sent.push({ target, text });
  }

  /**
   * Stream Mode WS 主循环：EVENT 帧回 ACK（code 200 + echo messageId/topic）后分发；
   * 协议级 ping 每 60s（钉钉断开不发心跳的连接）；SYSTEM/disconnect 帧只记录不 ack。
   */
  connectStream(
    conn: DingTalkConnection,
    onEvent: (frame: DingTalkEventFrame) => void,
    log?: (m: string) => void,
    WsImpl?: StreamWebSocketCtor,
  ): DingTalkHandle {
    const WS = WsImpl ?? (globalThis as unknown as { WebSocket?: StreamWebSocketCtor }).WebSocket;
    if (!WS) throw new DingTalkError("无 WebSocket 实现（测试可注入 WsImpl）");
    const url = `${conn.endpoint}?ticket=${encodeURIComponent(conn.ticket)}`;
    const ws = new WS(url) as StreamWebSocket;
    let stopped = false;
    // 心跳：生产实现有 ping()；缺 ping 的实现（简陋测试桩）跳过，仅日志提醒
    const pingTimer = setInterval(() => {
      if (typeof ws.ping === "function") ws.ping();
    }, 60_000);
    ws.on("message", (raw: unknown) => {
      let frame: DingTalkEventFrame & { message?: string };
      try {
        frame = JSON.parse(String(raw)) as DingTalkEventFrame;
      } catch (e) {
        log?.(`非 JSON 帧忽略：${e instanceof Error ? e.message : e}`);
        return;
      }
      if (frame.type !== "EVENT" && frame.type !== "CALLBACK") {
        log?.(`系统帧忽略：${frame.headers?.topic ?? frame.type}`);
        return;
      }
      // ACK：code 200 + 回带原 messageId/topic（官方 SDK AckMessage 结构，data 为字符串化 JSON）
      ws.send(
        JSON.stringify({
          code: 200,
          headers: { contentType: "application/json", messageId: frame.headers?.messageId, topic: frame.headers?.topic },
          message: "",
          data: "{}",
        }),
      );
      onEvent(frame);
    });
    ws.on("close", () => log?.("stream closed"));
    ws.on("error", (err: Error) => log?.(`stream 错误：${err.message}`));
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(pingTimer);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
}
