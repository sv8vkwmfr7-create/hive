/** 钉钉机器人消息 EVENT 帧解析：只认 /v1.0/im/bot/messages/get 文本消息 */

export interface ParsedDingTalkMessage {
  /** headers.messageId（去重键，官方 SDK 同款） */
  messageId: string;
  conversationType: "1" | "2";
  /** 单聊 = openConversationId（回复走 senderId），群聊 = openConversationId */
  chatId: string;
  senderId: string;
  robotCode: string;
  text: string;
}

export function parseDingTalkEvent(frame: unknown): ParsedDingTalkMessage | null {
  const f = frame as { type?: string; headers?: { topic?: string; messageId?: string }; data?: unknown };
  if (!f || f.type !== "EVENT" || f.headers?.topic !== "/v1.0/im/bot/messages/get") return null;
  // data 在 wire 上是 JSON 字符串（官方 SDK from_dict 证实）
  let m: {
    conversationType?: string;
    conversationId?: string;
    senderStaffId?: string;
    senderId?: string;
    robotCode?: string;
    text?: { content?: string };
  };
  try {
    m = typeof f.data === "string" ? (JSON.parse(f.data) as typeof m) : (f.data as typeof m);
  } catch {
    return null;
  }
  if (!m || typeof m.conversationType !== "string" || (m.conversationType !== "1" && m.conversationType !== "2")) return null;
  const text = String(m.text?.content ?? "").trim();
  if (!text || text.startsWith("/")) return null;
  const senderId = m.senderStaffId ?? m.senderId ?? "";
  const chatId = m.conversationType === "2" ? String(m.conversationId ?? "") : senderId;
  if (!chatId || !senderId) return null;
  return {
    messageId: f.headers?.messageId ?? "",
    conversationType: m.conversationType,
    chatId,
    senderId,
    robotCode: String(m.robotCode ?? ""),
    text,
  };
}
