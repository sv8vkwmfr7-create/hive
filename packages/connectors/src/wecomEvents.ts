/** 企微回调明文解析：官方默认 XML（CDATA），应用可配 JSON；本解析器两者通吃 */

export interface ParsedWecomMessage {
  /** MsgId（去重键：企微重推带同 MsgId） */
  msgId: string;
  /** FromUserName = 发消息成员的 userid（回复 touser） */
  fromUser: string;
  text: string;
  agentId: string;
}

/** XML 标签提取：兼容 <Tag><![CDATA[v]]></Tag> 与 <Tag>v</Tag>，键名大小写不敏感 */
function xmlTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m?.[1];
}

export function parseWecomPlaintext(plain: string): ParsedWecomMessage | null {
  // 统一取值：先按 XML 找，找不到再按 JSON 小写键找（两种明文格式通吃）
  const lower = (): Record<string, string> => {
    try {
      const doc = JSON.parse(plain) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(doc)) out[k.toLowerCase()] = String(v);
      return out;
    } catch {
      return {};
    }
  };
  const byXml = (key: string): string | undefined => xmlTag(plain, key);
  const byJson = (key: string): string | undefined => {
    const doc = jsonCache ?? (jsonCache = lower());
    return doc[key.toLowerCase()];
  };
  let jsonCache: Record<string, string> | null = null;
  const get = (key: string): string | undefined => byXml(key) ?? byJson(key);

  const msgType = (get("MsgType") ?? "").toLowerCase();
  if (msgType !== "text") return null;
  const content = (get("Content") ?? "").trim();
  if (!content || content.startsWith("/")) return null;
  const fromUser = get("FromUserName") ?? "";
  if (!fromUser) return null;
  return {
    msgId: get("MsgId") ?? "",
    fromUser,
    text: content,
    agentId: get("AgentID") ?? "",
  };
}
