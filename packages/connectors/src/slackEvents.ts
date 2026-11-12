/** Slack Events API payload 解析：只认文本消息，忽略 bot 自己、消息编辑等 subtype */

export interface ParsedSlackMessage {
  /** Events API event_id（去重用：Slack 会重投未确认事件） */
  eventId: string;
  chatId: string;
  senderId: string;
  text: string;
}

export function parseSlackEventCallback(payload: unknown): ParsedSlackMessage | null {
  const p = payload as { type?: string; event_id?: string; event?: { type?: string; channel?: string; user?: string; text?: string; bot_id?: string; subtype?: string } };
  if (!p || p.type !== "event_callback") return null;
  const ev = p.event;
  if (!ev || (ev.type !== "message" && ev.type !== "app_mention")) return null;
  if (typeof ev.text !== "string") return null;
  const text = ev.text.trim();
  if (!text || text.startsWith("/")) return null;
  if (ev.bot_id) return null; // bot 互聊防死循环（bot 消息都有 bot_id）
  if (ev.subtype) return null; // message_changed / channel_join 等系统消息不建任务
  return {
    eventId: p.event_id ?? "",
    chatId: String(ev.channel ?? ""),
    senderId: String(ev.user ?? ""),
    text,
  };
}
