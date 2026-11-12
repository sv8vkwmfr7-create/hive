/**
 * Slack API 客户端：Web API 发消息（xoxb bot token）+ Socket Mode 收事件（xapp app-level token）。
 * Socket Mode 免公网——与 Discord gateway 同款离线可测模式（WS 实现可注入）。
 */
export interface SlackClientOptions {
  /** Bot User OAuth Token（xoxb-…），Web API 发消息用 */
  botToken: string;
  /** App-Level Token（xapp-…），Socket Mode 握手用 */
  appToken: string;
  /** 默认 https://slack.com/api */
  restBaseUrl?: string;
  /** 默认 wss://socket-mode.slack.com（URL 会带 app_level_token 查询参数） */
  socketBaseUrl?: string;
}

export class SlackError extends Error {}

export interface SentSlackMessage {
  chatId: string;
  text: string;
  ts?: string;
}

export interface SlackEnvelope {
  /** 传输层类型：events_api / interactive / slash_commands / connection_debug … */
  type: string;
  envelope_id: string;
  payload: Record<string, unknown>;
}

export interface SlackHandle {
  stop: () => void;
}

/** 最小 WebSocket 结构：与 discordApi 同款，生产用 ws 包实例，测试可注入 */
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  on(event: "message", cb: (raw: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}
export interface MinimalWebSocketCtor {
  new (url: string): MinimalWebSocket;
}

export class SlackClient {
  /** 测试观测点：发出的消息 */
  sent: SentSlackMessage[] = [];

  constructor(private opts: SlackClientOptions) {}

  private rest(): string {
    return (this.opts.restBaseUrl ?? "https://slack.com/api").replace(/\/$/, "");
  }

  private socketUrl(): string {
    return `${(this.opts.socketBaseUrl ?? "wss://socket-mode.slack.com").replace(/\/$/, "")}?app_level_token=${encodeURIComponent(this.opts.appToken)}`;
  }

  /** Web API chat.postMessage（channel 维度，text 支持 Slack mrkdwn） */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const res = await fetch(`${this.rest()}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.botToken}` },
      body: JSON.stringify({ channel: chatId, text }),
    });
    const doc = (await res.json()) as { ok?: boolean; error?: string; ts?: string };
    if (!res.ok || !doc.ok) throw new SlackError(`chat.postMessage 失败：${res.status} ${doc.error ?? ""}`);
    this.sent.push({ chatId, text, ts: doc.ts });
  }

  /**
   * Socket Mode WebSocket：hello → 收信封（必须 ack）+ ping/pong。
   * 协议要求先 ack 再处理（Slack 会因未 ack 断开并重投；重投由连接器去重兜底）。
   */
  connectSocket(
    onEnvelope: (e: SlackEnvelope) => void,
    log?: (m: string) => void,
    WsImpl?: MinimalWebSocketCtor,
  ): SlackHandle {
    const WS = WsImpl ?? (globalThis as unknown as { WebSocket?: MinimalWebSocketCtor }).WebSocket;
    if (!WS) throw new SlackError("无 WebSocket 实现（测试可注入 WsImpl）");
    const ws = new WS(this.socketUrl()) as MinimalWebSocket;
    let stopped = false;
    ws.on("message", (raw: unknown) => {
      let msg: { type?: string; envelope_id?: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch (e) {
        log?.(`非 JSON 帧忽略：${e instanceof Error ? e.message : e}`);
        return;
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type === "hello") {
        log?.("socket mode connected (hello)");
        return;
      }
      if (msg.envelope_id) {
        // 协议强制：收到信封先 ack，否则 Slack 判超时断开重投
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        onEnvelope({
          type: msg.type ?? "unknown",
          envelope_id: msg.envelope_id,
          payload: msg.payload ?? {},
        });
        return;
      }
      log?.(`未知帧忽略：${String(msg.type ?? "?")}`);
    });
    ws.on("close", () => log?.("socket closed"));
    ws.on("error", (err: Error) => log?.(`socket 错误：${err.message}`));
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
}
