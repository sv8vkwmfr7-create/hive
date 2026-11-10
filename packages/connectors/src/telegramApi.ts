/**
 * Telegram Bot API 客户端：长轮询取更新 + 发消息。
 * baseUrl 可注入——离线测试指向假 Telegram 服务器，token 到位后零改动切官方端点。
 * 备胎定位（风险表）：飞书未就绪时的开发期主通道；凭据只进 .env。
 */
export interface TelegramClientOptions {
  token: string;
  /** 默认 https://api.telegram.org */
  baseUrl?: string;
}

export class TelegramError extends Error {}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
  edited_message?: unknown;
}

export interface SentMessage {
  chatId: string;
  text: string;
  messageId?: number;
}

export class TelegramClient {
  /** 测试观测点：发出的消息 */
  sent: SentMessage[] = [];

  constructor(private opts: TelegramClientOptions) {}

  private base(): string {
    return (this.opts.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
  }

  private url(method: string): string {
    return `${this.base()}/bot${this.opts.token}/${method}`;
  }

  /** 长轮询取更新（timeout 秒；返回空数组表示无新消息） */
  async getUpdates(offset: number, timeoutSec = 25): Promise<TelegramUpdate[]> {
    const res = await fetch(this.url(`getUpdates?offset=${offset}&timeout=${timeoutSec}`), {
      signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
    });
    const doc = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
    if (!doc.ok) throw new TelegramError(`getUpdates 失败：${doc.description ?? "unknown"}`);
    return doc.result ?? [];
  }

  /** 发文本消息到会话（chat_id 维度） */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const res = await fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const doc = (await res.json()) as { ok?: boolean; description?: string; result?: { message_id?: number } };
    if (!doc.ok) throw new TelegramError(`sendMessage 失败：${doc.description ?? "unknown"}`);
    this.sent.push({ chatId, text, messageId: doc.result?.message_id });
  }
}
