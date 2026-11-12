import { STATUS_GLYPH } from "@hive/shared";
import { HiveKernel, replayTask } from "@hive/kernel";
import { parseSlackEventCallback } from "./slackEvents.js";
import type { SlackClient, SlackEnvelope, SlackHandle } from "./slackApi.js";

export interface SlackConnectorOptions {
  kernel: HiveKernel;
  defaultBudgetUsd?: number;
  log?: (msg: string) => void;
}

const MAX_SEEN_EVENTS = 2000;
const SOURCE_PREFIX = "slack:";

/**
 * Slack 连接器 v0（L1 第 4 套）：Socket Mode events_api 信封 → 发一句话 → 内核建任务自动跑 → 终态回帖。
 * 与 feishu/telegram/discord 同一闭环与原则：门禁在内核，连接器只搬运与回复；
 * bot 自发消息（bot_id）忽略防互聊；event_id 去重（ack 先行 → Slack 重投时兜底）。
 */
export class SlackConnector {
  private seenEventIds = new Set<string>();
  private repliedTasks = new Set<string>();
  private offKernel: () => void;

  constructor(
    private opts: SlackConnectorOptions,
    private replyClient?: SlackClient,
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
    this.opts.log?.(`[slack] ${msg}`);
  }

  /** 处理 Socket Mode 信封：只认 events_api 且为文本消息 → 去重 → 建任务自动跑 */
  handleEnvelope(envelope: SlackEnvelope): void {
    if (envelope.type !== "events_api") return;
    const parsed = parseSlackEventCallback(envelope.payload);
    if (!parsed) {
      this.log(`忽略非任务信封（非 event_callback / bot 自发 / subtype / 非文本）`);
      return;
    }
    if (parsed.eventId && this.seenEventIds.has(parsed.eventId)) {
      this.log(`重复事件（重投），忽略：${parsed.eventId}`);
      return;
    }
    if (parsed.eventId) {
      this.seenEventIds.add(parsed.eventId);
      if (this.seenEventIds.size > MAX_SEEN_EVENTS) {
        this.seenEventIds.delete(this.seenEventIds.values().next().value as string);
      }
    }
    const taskId = this.opts.kernel.createTask({
      title: parsed.text.slice(0, 24) || "Slack 任务",
      brief: parsed.text,
      budgetUsd: this.opts.defaultBudgetUsd ?? 3,
      source: `${SOURCE_PREFIX}${parsed.chatId}:${parsed.senderId}`,
    });
    this.log(`任务 #${taskId} 来自频道 ${parsed.chatId}（${parsed.text.slice(0, 30)}…）`);
    void this.opts.kernel.runTask(taskId).catch((err) => {
      this.log(`runTask #${taskId} 意外失败：${errText(err)}`);
    });
  }

  /** 任务终态/熔断 → 回帖到来源频道（source 落在 task.created payload，重启也能找回） */
  private async maybeReply(taskId: string, kind: string): Promise<void> {
    if (!this.replyClient || this.repliedTasks.has(taskId)) return;
    const created = this.opts.kernel.store.replayTaskEvents(taskId).find((e) => e.kind === "task.created");
    if (!created) return;
    const source = (created.payload as { source?: string }).source ?? "";
    if (!source.startsWith(SOURCE_PREFIX)) return;
    const chatId = source.slice(SOURCE_PREFIX.length).split(":")[0];
    if (!chatId) return;

    this.repliedTasks.add(taskId);
    const summary = this.buildSummary(taskId, kind);
    await this.replyClient.sendMessage(chatId, summary);
    this.log(`已回帖任务 #${taskId} → ${chatId}`);
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

/** Socket Mode 主循环封装：envelope → connector；返回 stop() */
export function startSlackSocket(opts: {
  client: SlackClient;
  connector: SlackConnector;
  log?: (msg: string) => void;
  WsImpl?: typeof import("ws").WebSocket;
}): SlackHandle {
  return opts.client.connectSocket((e) => opts.connector.handleEnvelope(e), opts.log, opts.WsImpl);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
