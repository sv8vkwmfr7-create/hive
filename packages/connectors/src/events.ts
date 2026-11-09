/** 飞书事件订阅回调的结构与解析（v2.0 事件格式） */

export interface UrlVerification {
  type: "url_verification";
  challenge?: string;
  encrypt?: string;
  token?: string;
}

export interface EventHeader {
  event_id: string;
  event_type: string;
  token?: string;
  create_time?: string;
}

export interface ParsedImMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
}

/** 解析 im.message.receive_v1：只认文本消息，剥掉 @机器人 占位符 */
export function parseImMessage(event: unknown): ParsedImMessage | null {
  const e = event as {
    message?: { message_id?: string; message_type?: string; chat_id?: string; content?: string };
    sender?: { sender_id?: { open_id?: string } };
  };
  const message = e?.message;
  if (!message || message.message_type !== "text") return null;
  let text = "";
  try {
    text = String(JSON.parse(message.content ?? "{}").text ?? "");
  } catch {
    return null;
  }
  text = text.replace(/@_user_\d+/g, "").trim();
  if (!text) return null;
  return {
    messageId: message.message_id ?? "",
    chatId: message.chat_id ?? "",
    senderId: e.sender?.sender_id?.open_id ?? "",
    text,
  };
}
