/**
 * Discord Bot API 客户端：REST 发消息 + Gateway WebSocket 收事件。
 * baseUrl/broker 可注入——离线测试指向假服务器，token 到位后零改动切官方端点。
 */
export interface DiscordClientOptions {
  token: string;
  /** 默认 https://discord.com/api/v10 */
  restBaseUrl?: string;
  /** 默认 wss://gateway.discord.gg/?v=10&encoding=json */
  gatewayUrl?: string;
}

export class DiscordError extends Error {}

export interface DiscordMessageEvent {
  /** gateway 事件 id（去重用：message.id） */
  messageId: string;
  chatId: string;
  senderId: string;
  botId?: string;
  text: string;
}

export interface SentDiscordMessage {
  chatId: string;
  text: string;
  messageId?: string;
}

export interface GatewayDispatch {
  t: string | null;
  d: Record<string, unknown> | null;
}

export interface GatewayHandle {
  stop: () => void;
}

/** 最小 WebSocket 结构：生产用 ws 包实例，测试可注入任意实现 */
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

export class DiscordClient {
  /** 测试观测点：发出的消息 */
  sent: SentDiscordMessage[] = [];

  constructor(private opts: DiscordClientOptions) {}

  private rest(): string {
    return (this.opts.restBaseUrl ?? "https://discord.com/api/v10").replace(/\/$/, "");
  }

  private gateway(): string {
    return this.opts.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
  }

  get token(): string {
    return this.opts.token;
  }

  /** REST 发文本消息到频道/私聊（channel_id 维度） */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const res = await fetch(`${this.rest()}/channels/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bot ${this.opts.token}` },
      body: JSON.stringify({ content: text }),
    });
    const doc = (await res.json()) as { id?: string; message?: string };
    if (!res.ok) throw new DiscordError(`sendMessage 失败：${res.status} ${doc.message ?? ""}`);
    this.sent.push({ chatId, text, messageId: doc.id });
  }

  /**
   * Gateway WebSocket：identify → heartbeat → dispatch 回调。
   * 返回 stop()；断线由调用方决定重连策略（demo 里重启整个 handle）。
   */
  connectGateway(onDispatch: (d: GatewayDispatch) => void, log?: (m: string) => void, WsImpl?: MinimalWebSocketCtor): GatewayHandle {
    const WS = WsImpl ?? (globalThis as unknown as { WebSocket?: MinimalWebSocketCtor }).WebSocket;
    if (!WS) throw new DiscordError("无 WebSocket 实现（测试可注入 WsImpl）");
    const ws = new WS(this.gateway()) as MinimalWebSocket;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const heartbeat = (intervalMs: number): void => {
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        ws.send(JSON.stringify({ op: 1, d: null }));
      }, intervalMs);
    };
    ws.on("message", (raw: unknown) => {
      const payload = JSON.parse(String(raw)) as { op: number; t: string | null; d: Record<string, unknown> | null };
      if (payload.op === 10) {
        const intervalMs = Number((payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 45000);
        heartbeat(intervalMs);
        ws.send(
          JSON.stringify({
            op: 2,
            d: {
              token: this.opts.token,
              intents: 1 /* GUILDS */ | 512 /* GUILD_MESSAGES */ | 4096 /* DIRECT_MESSAGES */ | 32768 /* MESSAGE_CONTENT */,
              properties: { os: "linux", browser: "hive", device: "hive" },
            },
          }),
        );
        log?.("gateway identified");
        return;
      }
      if (payload.op === 0 && payload.t) onDispatch({ t: payload.t, d: payload.d });
    });
    ws.on("close", () => clearInterval(heartbeatTimer));
    ws.on("error", (err: Error) => {
      log?.(`gateway 错误：${err.message}`);
    });
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(heartbeatTimer);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  }
}
