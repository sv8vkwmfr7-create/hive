/**
 * 企微 API 客户端：gettoken 缓存 + message/send 应用消息。
 * baseUrl 可注入——离线测试指向假服务器，真凭据到位后零改动切官方端点。
 */
export interface WeComClientOptions {
  corpId: string;
  corpSecret: string;
  /** 默认 https://qyapi.weixin.qq.com */
  baseUrl?: string;
}

export class WeComError extends Error {}

export interface SentWecomMessage {
  toUser: string;
  text: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class WeComClient {
  private token: CachedToken | null = null;
  /** 测试观测点：发出的消息 */
  sent: SentWecomMessage[] = [];

  constructor(private opts: WeComClientOptions) {}

  private base(): string {
    return (this.opts.baseUrl ?? "https://qyapi.weixin.qq.com").replace(/\/$/, "");
  }

  private async ensureAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await fetch(`${this.base()}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.opts.corpId)}&corpsecret=${encodeURIComponent(this.opts.corpSecret)}`);
    const doc = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!res.ok || !doc.access_token) throw new WeComError(`gettoken 失败：${doc.errcode ?? res.status} ${doc.errmsg ?? ""}`);
    // 提前 60s 过期，避免临界点撞 token 失效
    this.token = { value: doc.access_token, expiresAt: Date.now() + Math.max(60_000, (doc.expires_in ?? 7200) * 1000 - 60_000) };
    return this.token.value;
  }

  /** 应用消息 text（agentId 在响应里校验回显）；企微 API 通用约定：返回体 errcode=0 才算成功 */
  async sendMessage(agentId: string | number, toUser: string, text: string): Promise<void> {
    const token = await this.ensureAccessToken();
    const res = await fetch(`${this.base()}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ touser: toUser, msgtype: "text", agentid: Number(agentId), text: { content: text } }),
    });
    const doc = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (!res.ok || (doc.errcode ?? 0) !== 0) throw new WeComError(`message/send 失败：${doc.errcode ?? res.status} ${doc.errmsg ?? ""}`);
    this.sent.push({ toUser, text });
  }
}
