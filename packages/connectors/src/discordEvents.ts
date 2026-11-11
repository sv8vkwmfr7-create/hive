/** Discord MESSAGE_CREATE 的解析：只认文本消息，忽略 bot 自己与斜杠命令 */

export interface ParsedDiscordMessage {
  messageId: string;
  chatId: string;
  senderId: string;
  botId?: string;
  text: string;
}

export function parseDiscordMessage(d: unknown): ParsedDiscordMessage | null {
  const m = d as {
    id?: string;
    channel_id?: string;
    author?: { id?: string; bot?: boolean };
    content?: string;
  };
  if (!m || typeof m.content !== "string") return null;
  const text = m.content.trim();
  if (!text || text.startsWith("/")) return null;
  if (m.author?.bot) return null; // bot 互聊防死循环
  return {
    messageId: m.id ?? "",
    chatId: String(m.channel_id ?? ""),
    senderId: String(m.author?.id ?? ""),
    botId: m.author?.bot ? "bot" : undefined,
    text,
  };
}
