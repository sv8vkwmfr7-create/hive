/**
 * 飞书开放平台 API 客户端：tenant_access_token 缓存 + 发消息。
 * baseUrl 可注入——离线测试指向假飞书服务器，真凭据到位后零改动切官方端点。
 */
export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  /** 默认 https://open.feishu.cn */
  baseUrl?: string;
}

export class FeishuError extends Error {}

export interface SentMessage {
  chatId: string;
  text: string;
  messageId?: string;
}

export class FeishuClient {
  private token?: { value: string; expiresAt: number };
  /** 测试观测点：token 拉取次数 */
  tokenFetches = 0;
  /** 测试观测点：发出的消息 */
  sent: SentMessage[] = [];

  constructor(private opts: FeishuClientOptions) {}

  private base(): string {
    return (this.opts.baseUrl ?? "https://open.feishu.cn").replace(/\/$/, "");
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    this.tokenFetches += 1;
    const res = await fetch(`${this.base()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
    });
    const doc = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!doc.tenant_access_token) {
      throw new FeishuError(`获取 tenant_access_token 失败：code=${doc.code} ${doc.msg ?? ""}`);
    }
    this.token = {
      value: doc.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, (doc.expire ?? 7200) - 60) * 1000,
    };
    return this.token.value;
  }

  /** 发文本消息到会话（chat_id 维度） */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const token = await this.getToken();
    const res = await fetch(`${this.base()}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }),
    });
    const doc = (await res.json()) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (doc.code !== 0) {
      throw new FeishuError(`发消息失败：code=${doc.code} ${doc.msg ?? ""}`);
    }
    this.sent.push({ chatId, text, messageId: doc.data?.message_id });
  }
}
