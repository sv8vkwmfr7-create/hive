import { STATUS_GLYPH } from "@hive/shared";
import { HiveKernel, replayTask } from "@hive/kernel";
import { wecomDecrypt, wecomSignature } from "./wecomCrypto.js";
import { parseWecomPlaintext } from "./wecomEvents.js";
import type { WeComClient } from "./wecomApi.js";

export interface WeComConnectorOptions {
  kernel: HiveKernel;
  /** 回调配置三件套：接收消息 URL 配置页的 Token + EncodingAESKey + 企业 corpid */
  token: string;
  encodingAesKey: string;
  corpId: string;
  defaultBudgetUsd?: number;
  log?: (msg: string) => void;
}

export interface WecomVerifyQuery {
  msg_signature: string;
  timestamp: string;
  nonce: string;
  echostr: string;
}

export interface WecomCallbackInput {
  msg_signature: string;
  timestamp: string;
  nonce: string;
  /** POST body：JSON {tousername, encrypt, agentid} 或 XML <Encrypt>，取 encrypt 字段即可 */
  body: string;
}

export interface WecomHandleResult {
  /** HTTP 状态码：403 = 验签失败；200 = 已接收（body 见 reply） */
  status: number;
  /** GET 验证 = echostr 明文原样返回；POST = 空串（企微只看状态码） */
  reply: string;
}

const MAX_SEEN_MSGS = 2000;
const SOURCE_PREFIX = "wecom:";

/**
 * 企微连接器 v0（L1 第 6 套）：自建应用回调（回调模式需公网 URL）→ 发一句话 → 内核建任务自动跑 → 应用消息回帖。
 * 与 feishu webhook 同款纯函数形状：handleVerifyUrl / handleCallback 可直接挂任意 HTTP server。
 * 安全：验签不过 → 403 不建任务；corpid 不匹配的密文拒绝；MsgId 去重。
 * 范围：v0 回复走 message/send touser=FromUserName（单聊直达；群聊场景回私聊）。
 */
export class WeComConnector {
  private seenMsgIds = new Set<string>();
  private repliedTasks = new Set<string>();
  private offKernel: () => void;

  constructor(
    private opts: WeComConnectorOptions,
    private replyClient?: WeComClient,
  ) {
    this.offKernel = opts.kernel.onEvent((e) => {
      if (e.kind !== "task.status_changed" && e.kind !== "run.paused") return;
      void this.maybeReply(e.taskId, e.kind).catch((err) => this.log(`回帖失败 #${e.taskId}：${errText(err)}`));
    });
  }

  close(): void {
    this.offKernel();
  }

  private log(msg: string): void {
    this.opts.log?.(`[wecom] ${msg}`);
  }

  /** GET 接收消息 URL 验证：验签 → 解密 echostr → 明文原样返回（官方要求不加引号不加工） */
  handleVerifyUrl(query: WecomVerifyQuery): WecomHandleResult {
    try {
      const expect = wecomSignature(this.opts.token, query.timestamp, query.nonce, query.echostr);
      if (expect !== query.msg_signature) {
        this.log(`URL 验证签名不匹配，拒绝`);
        return { status: 403, reply: "" };
      }
      const { msg, receiveid } = wecomDecrypt(query.echostr, this.opts.encodingAesKey);
      if (receiveid !== this.opts.corpId) {
        this.log(`URL 验证 receiveid 与 corpid 不匹配，拒绝`);
        return { status: 403, reply: "" };
      }
      return { status: 200, reply: msg };
    } catch (e) {
      this.log(`URL 验证失败：${errText(e)}`);
      return { status: 403, reply: "" };
    }
  }

  /** POST 回调：验签 → 解密 → 解析 → 去重 → 建任务自动跑；一律快速 200（企微 5s 超时重推） */
  handleCallback(input: WecomCallbackInput): WecomHandleResult {
    try {
      const encrypt = extractEncrypt(input.body);
      if (!encrypt) {
        this.log(`回调 body 无 encrypt 字段，忽略`);
        return { status: 200, reply: "" };
      }
      const expect = wecomSignature(this.opts.token, input.timestamp, input.nonce, encrypt);
      if (expect !== input.msg_signature) {
        this.log(`回调签名不匹配，拒绝（不建任务）`);
        return { status: 403, reply: "" };
      }
      const { msg, receiveid } = wecomDecrypt(encrypt, this.opts.encodingAesKey);
      if (receiveid !== this.opts.corpId) {
        this.log(`回调 receiveid 与 corpid 不匹配，拒绝`);
        return { status: 403, reply: "" };
      }
      const parsed = parseWecomPlaintext(msg);
      if (!parsed) {
        this.log(`忽略非任务消息（非文本/斜杠/空）`);
        return { status: 200, reply: "" };
      }
      if (parsed.msgId && this.seenMsgIds.has(parsed.msgId)) {
        this.log(`重复消息（重推），忽略：${parsed.msgId}`);
        return { status: 200, reply: "" };
      }
      if (parsed.msgId) {
        this.seenMsgIds.add(parsed.msgId);
        if (this.seenMsgIds.size > MAX_SEEN_MSGS) {
          this.seenMsgIds.delete(this.seenMsgIds.values().next().value as string);
        }
      }
      const taskId = this.opts.kernel.createTask({
        title: parsed.text.slice(0, 24) || "企微任务",
        brief: parsed.text,
        budgetUsd: this.opts.defaultBudgetUsd ?? 3,
        source: `${SOURCE_PREFIX}${parsed.fromUser}:${parsed.agentId}`,
      });
      this.log(`任务 #${taskId} 来自成员 ${parsed.fromUser}（${parsed.text.slice(0, 30)}…）`);
      void this.opts.kernel.runTask(taskId).catch((err) => {
        this.log(`runTask #${taskId} 意外失败：${errText(err)}`);
      });
      return { status: 200, reply: "" };
    } catch (e) {
      // 解密失败等数据问题：如实 403 拒绝，不吞
      this.log(`回调处理失败：${errText(e)}`);
      return { status: 403, reply: "" };
    }
  }

  /** 任务终态/熔断 → 应用消息回发给来源成员（source 落 task.created payload，重启也能找回） */
  private async maybeReply(taskId: string, kind: string): Promise<void> {
    if (!this.replyClient || this.repliedTasks.has(taskId)) return;
    const created = this.opts.kernel.store.replayTaskEvents(taskId).find((e) => e.kind === "task.created");
    if (!created) return;
    const source = (created.payload as { source?: string }).source ?? "";
    if (!source.startsWith(SOURCE_PREFIX)) return;
    const [fromUser, agentId] = source.slice(SOURCE_PREFIX.length).split(":");
    if (!fromUser || !agentId) return;

    this.repliedTasks.add(taskId);
    const summary = this.buildSummary(taskId, kind);
    await this.replyClient.sendMessage(agentId, fromUser, summary);
    this.log(`已回帖任务 #${taskId} → ${fromUser}`);
  }

  private buildSummary(taskId: string, kind: string): string {
    const rp = replayTask(this.opts.kernel.store, taskId);
    const created = rp.timeline.find((t) => t.kind === "task.created");
    const title = (created?.payload as { title?: string } | undefined)?.title ?? "";
    const budgetUsd = (created?.payload as { budgetUsd?: number } | undefined)?.budgetUsd;
    const lastStatus = [...rp.timeline].reverse().find((t) => t.kind === "task.status_changed");
    const to = (lastStatus?.payload as { to?: keyof typeof STATUS_GLYPH } | undefined)?.to;
    const glyph = kind === "run.paused" ? "⏸️" : to ? STATUS_GLYPH[to] : "🔄";
    const reason =
      (lastStatus?.payload as { reason?: string } | undefined)?.reason ??
      (kind === "run.paused" ? "预算熔断，自动暂停" : "");
    const artifacts = rp.timeline
      .filter((t) => t.kind === "artifact.produced")
      .map((t) => String((t.payload as { path: string }).path).split(/[\\/]/).at(-1));
    const lines = [
      `${glyph} 蜂巢 · 任务 #${taskId}「${title}」`,
      reason ? `说明：${reason}` : "",
      `花费：$${rp.receipt.totalUsd.toFixed(2)}${budgetUsd != null ? ` / 预算 $${budgetUsd}` : ""}`,
      artifacts.length ? `产物：${artifacts.join("、")}` : "",
      `小票：data/ledger/task-${taskId}.receipt.json`,
    ];
    return lines.filter(Boolean).join("\n");
  }
}

/** 从回调 body 提取 encrypt：JSON {encrypt} 或 XML <Encrypt><![CDATA[…]]></Encrypt> */
function extractEncrypt(body: string): string | undefined {
  const trimmed = body.trim();
  try {
    const doc = JSON.parse(trimmed) as { encrypt?: string };
    if (typeof doc.encrypt === "string") return doc.encrypt;
  } catch {
    /* XML 模式 */
  }
  const m = trimmed.match(/<Encrypt>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/Encrypt>/i);
  return m?.[1];
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
