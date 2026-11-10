/** Telegram update 的结构与解析：只认文本消息（斜杠命令是控制面，不当任务） */

export interface ParsedTelegramMessage {
  updateId: number;
  messageId: number;
  chatId: string;
  senderId: string;
  text: string;
}

export function parseTelegramUpdate(update: unknown): ParsedTelegramMessage | null {
  const u = update as {
    update_id?: number;
    message?: { message_id?: number; chat?: { id?: number }; from?: { id?: number }; text?: string };
    edited_message?: unknown;
  };
  if (!u || typeof u.update_id !== "number") return null;
  const msg = u.message; // edited_message 等一律忽略（编辑不改已建任务）
  if (!msg || typeof msg.text !== "string") return null;
  const text = msg.text.trim();
  if (!text || text.startsWith("/")) return null; // 斜杠命令 = 控制面，不建任务
  return {
    updateId: u.update_id,
    messageId: msg.message_id ?? 0,
    chatId: String(msg.chat?.id ?? ""),
    senderId: String(msg.from?.id ?? ""),
    text,
  };
}
