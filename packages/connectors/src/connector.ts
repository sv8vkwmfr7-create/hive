import { STATUS_GLYPH } from "@hive/shared";
import { HiveKernel, replayTask } from "@hive/kernel";
import { decryptLark, larkSignature } from "./crypto.js";
import { parseImMessage } from "./events.js";
import { FeishuClient } from "./feishuApi.js";

export interface FeishuConnectorOptions {
  kernel: HiveKernel;
  /** 未配凭据时传 null：只收事件建任务，不回帖（发消息链路待凭据） */
  client: FeishuClient | null;
  /** 飞书事件订阅的 encrypt_key（.env: FEISHU_ENCRYPT_KEY）；不配则不验签、不解密 */
  encryptKey?: string;
  defaultBudgetUsd?: number;
  log?: (msg: string) => void;
}

export interface CallbackResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CallbackHeaders {
  /** x-lark-signature / x-lark-request-timestamp / x-lark-request-nonce */
  signature?: string;
  timestamp?: string;
  nonce?: string;
}

const MAX_SEEN_EVENTS = 2000;
const SOURCE_PREFIX = "feishu:";

/**
 * 飞书连接器 v0：事件订阅 → 发一句话 → 内核建任务并自动跑 → 终态回帖。
 * 与 POST /api/tasks 同款闭环，只是入口从看板换成聊天工具。
 * 门禁在内核（预算/审批/交接校验），连接器只做搬运与回复，不做任何权限判断。
 */
export class FeishuConnector {
  private seenEventIds = new Set<string>();
  private repliedTasks = new Set<string>();
  private offKernel: () => void;

  constructor(
    private opts: FeishuConnectorOptions,
  ) {
    this.offKernel = opts.kernel.onEvent((e) => {
      if (e.kind !== "task.status_changed" && e.kind !== "run.paused") return;
      void this.maybeReply(e.taskId, e.kind).catch((err) => this.log(`回帖失败 #${e.taskId}：${errText(err)}`));
    });
  }

  /** 停止订阅（测试/关停用） */
  close(): void {
    this.offKernel();
  }

  private log(msg: string): void {
    this.opts.log?.(`[feishu] ${msg}`);
  }

  /**
   * 处理飞书回调（webhook 模式）。返回 HTTP 状态与响应体。
   * 任何非预期事件都回 200——飞书对非 200 会无限重试。
   */
  async handleCallback(rawBody: string, headers: CallbackHeaders = {}): Promise<CallbackResponse> {
    let outer: {
      type?: string;
      challenge?: string;
      encrypt?: string;
      header?: { event_id?: string; event_type?: string };
      event?: unknown;
    };
    try {
      outer = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { error: "回调体不是 JSON" } };
    }

    // 1. 签名门禁（配置了 encrypt_key 且带签名头才校验；签名对原始请求体计算）
    if (this.opts.encryptKey && headers.signature != null) {
      const expected = larkSignature(headers.timestamp ?? "", headers.nonce ?? "", this.opts.encryptKey, rawBody);
      if (expected !== headers.signature) {
        this.log("签名不匹配，拒绝");
        return { status: 403, body: { error: "signature mismatch" } };
      }
    }

    // 2. 解密事件体（加密模式下 url_verification 也在密文里）
    if (outer.encrypt) {
      try {
        outer = JSON.parse(decryptLark(outer.encrypt, this.requireKey()));
      } catch (err) {
        this.log(`事件解密失败：${errText(err)}`);
        return { status: 400, body: { error: "解密失败" } };
      }
    }

    // 3. URL 验证：challenge 原样还回去（明文或解密后）
    if (outer.type === "url_verification") {
      if (!outer.challenge) return { status: 400, body: { error: "缺少 challenge" } };
      this.log("url_verification 通过");
      return { status: 200, body: { challenge: outer.challenge } };
    }

    // 4. 明文事件路由（webhook 与长连接共用一套去重/解析/建任务）
    await this.handleEventObject(outer);
    return { status: 200, body: { code: 0 } };
  }

  /**
   * 明文事件对象入口（长连接模式直连此方法；webhook 在解密后调用）。
   * 去重 → 只认 im.message.receive_v1 → 文本消息 → 建任务自动跑。
   */
  async handleEventObject(event: unknown): Promise<void> {
    const evt = event as { header?: { event_id?: string; event_type?: string }; event?: unknown };
    const header = evt?.header;
    if (!header?.event_type) return;

    // 事件去重（飞书 webhook 会重试推送；长连接无重试但同源逻辑保持一致）
    if (header.event_id) {
      if (this.seenEventIds.has(header.event_id)) {
        this.log(`重复事件，忽略：${header.event_id}`);
        return;
      }
      this.seenEventIds.add(header.event_id);
      if (this.seenEventIds.size > MAX_SEEN_EVENTS) {
        this.seenEventIds.delete(this.seenEventIds.values().next().value as string);
      }
    }

    // 只认文本消息；其他事件吞掉
    if (header.event_type !== "im.message.receive_v1") return;
    const msg = parseImMessage(evt.event);
    if (!msg) {
      this.log(`忽略非文本消息（event_id=${header.event_id}）`);
      return;
    }

    // 发一句话 → 建任务 → 自动开跑（与 POST /api/tasks 同款闭环）
    const taskId = this.opts.kernel.createTask({
      title: msg.text.slice(0, 24) || "飞书任务",
      brief: msg.text,
      budgetUsd: this.opts.defaultBudgetUsd ?? 3,
      source: `${SOURCE_PREFIX}${msg.chatId}:${msg.senderId}`,
    });
    this.log(`任务 #${taskId} 来自群 ${msg.chatId}（${msg.text.slice(0, 30)}…）`);
    void this.opts.kernel.runTask(taskId).catch((err) => {
      this.log(`runTask #${taskId} 意外失败：${errText(err)}`);
    });
  }

  private requireKey(): string {
    if (!this.opts.encryptKey) throw new Error("收到加密事件但未配置 FEISHU_ENCRYPT_KEY");
    return this.opts.encryptKey;
  }

  /** 任务终态/熔断 → 回帖到来源群（source 落在 task.created payload，重启也能从事件找回） */
  private async maybeReply(taskId: string, kind: string): Promise<void> {
    if (!this.opts.client || this.repliedTasks.has(taskId)) return;
    const created = this.opts.kernel.store.replayTaskEvents(taskId).find((e) => e.kind === "task.created");
    if (!created) return;
    const source = (created.payload as { source?: string }).source ?? "";
    if (!source.startsWith(SOURCE_PREFIX)) return;
    const chatId = source.slice(SOURCE_PREFIX.length).split(":")[0];
    if (!chatId) return;

    this.repliedTasks.add(taskId);
    const summary = this.buildSummary(taskId, kind);
    await this.opts.client.sendMessage(chatId, summary);
    this.log(`已回帖任务 #${taskId} → ${chatId}`);
  }

  private buildSummary(taskId: string, kind: string): string {
    const rp = replayTask(this.kernelStore(), taskId);
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

  private kernelStore() {
    return this.opts.kernel.store;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
