import { STATUS_GLYPH } from "@hive/shared";
import { HiveKernel, replayTask } from "@hive/kernel";
import { parseDingTalkEvent } from "./dingtalkEvents.js";
import type { DingTalkClient, DingTalkEventFrame, DingTalkHandle, DingTalkReplyTarget } from "./dingtalkApi.js";

export interface DingTalkConnectorOptions {
  kernel: HiveKernel;
  defaultBudgetUsd?: number;
  log?: (msg: string) => void;
}

const MAX_SEEN_EVENTS = 2000;
const SOURCE_PREFIX = "dingtalk:";

/**
 * 钉钉连接器 v0（L1 第 5 套）：Stream Mode EVENT 帧 → 发一句话 → 内核建任务自动跑 → 终态回消息。
 * 与 feishu/telegram/discord/slack 同一闭环与原则：门禁在内核，连接器只搬运与回复。
 * 钉钉机器人只收 @机器人/单聊消息（无回声风险）；messageId 去重；
 * 回复寻址走 REST（conversationType + chatId + robotCode 落 source，重启可找回；
 * sessionWebhook 带临时凭据，绝不写事件流）。
 */
export class DingTalkConnector {
  private seenMessageIds = new Set<string>();
  private repliedTasks = new Set<string>();
  private offKernel: () => void;

  constructor(
    private opts: DingTalkConnectorOptions,
    private replyClient?: DingTalkClient,
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
    this.opts.log?.(`[dingtalk] ${msg}`);
  }

  /** 处理 Stream EVENT 帧：只认机器人文本消息，去重 → 建任务自动跑 */
  handleEvent(frame: DingTalkEventFrame): void {
    const parsed = parseDingTalkEvent(frame);
    if (!parsed) {
      this.log(`忽略非任务帧（topic 不符/非文本/斜杠）`);
      return;
    }
    if (parsed.messageId && this.seenMessageIds.has(parsed.messageId)) {
      this.log(`重复消息（重投），忽略：${parsed.messageId}`);
      return;
    }
    if (parsed.messageId) {
      this.seenMessageIds.add(parsed.messageId);
      if (this.seenMessageIds.size > MAX_SEEN_EVENTS) {
        this.seenEventEvict();
      }
    }
    const taskId = this.opts.kernel.createTask({
      title: parsed.text.slice(0, 24) || "钉钉任务",
      brief: parsed.text,
      budgetUsd: this.opts.defaultBudgetUsd ?? 3,
      source: `${SOURCE_PREFIX}${parsed.conversationType}:${parsed.chatId}:${parsed.senderId}:${parsed.robotCode}`,
    });
    this.log(`任务 #${taskId} 来自会话 ${parsed.conversationType === "2" ? "群" : "单聊"}（${parsed.text.slice(0, 30)}…）`);
    void this.opts.kernel.runTask(taskId).catch((err) => {
      this.log(`runTask #${taskId} 意外失败：${errText(err)}`);
    });
  }

  private seenEventEvict(): void {
    this.seenMessageIds.delete(this.seenMessageIds.values().next().value as string);
  }

  /** 任务终态/熔断 → 回消息到来源会话（source 五元组落 task.created payload，重启也能找回） */
  private async maybeReply(taskId: string, kind: string): Promise<void> {
    if (!this.replyClient || this.repliedTasks.has(taskId)) return;
    const created = this.opts.kernel.store.replayTaskEvents(taskId).find((e) => e.kind === "task.created");
    if (!created) return;
    const source = (created.payload as { source?: string }).source ?? "";
    if (!source.startsWith(SOURCE_PREFIX)) return;
    const parts = source.slice(SOURCE_PREFIX.length).split(":");
    if (parts.length < 4 || (parts[0] !== "1" && parts[0] !== "2")) return;
    const target: DingTalkReplyTarget = {
      conversationType: parts[0] as "1" | "2",
      chatId: parts[1],
      robotCode: parts[3],
    };
    if (!target.chatId || !target.robotCode) return;

    this.repliedTasks.add(taskId);
    const summary = this.buildSummary(taskId, kind);
    await this.replyClient.sendMessage(target, summary);
    this.log(`已回帖任务 #${taskId} → ${target.conversationType === "2" ? "群" : "单聊"} ${target.chatId}`);
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

/** Stream Mode 主循环封装：建连 + EVENT 分发；返回 stop() */
export async function startDingTalkStream(opts: {
  client: DingTalkClient;
  connector: DingTalkConnector;
  log?: (msg: string) => void;
  WsImpl?: typeof import("ws").WebSocket;
}): Promise<DingTalkHandle> {
  const conn = await opts.client.openConnection();
  return opts.client.connectStream(conn, (frame) => opts.connector.handleEvent(frame), opts.log, opts.WsImpl);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
