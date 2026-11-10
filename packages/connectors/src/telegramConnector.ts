import { STATUS_GLYPH } from "@hive/shared";
import { HiveKernel, replayTask } from "@hive/kernel";
import { parseTelegramUpdate } from "./telegramEvents.js";
import type { TelegramClient, TelegramUpdate } from "./telegramApi.js";

export interface TelegramConnectorOptions {
  kernel: HiveKernel;
  defaultBudgetUsd?: number;
  log?: (msg: string) => void;
}

const MAX_SEEN_UPDATES = 2000;
const SOURCE_PREFIX = "telegram:";

/**
 * Telegram 连接器 v0（备胎通道）：长轮询 → 发一句话 → 内核建任务自动跑 → 终态回帖。
 * 与飞书连接器同一套闭环与原则：门禁在内核，连接器只搬运与回复，不做权限判断。
 */
export class TelegramConnector {
  private seenUpdateIds = new Set<number>();
  private repliedTasks = new Set<string>();
  private offKernel: () => void;

  constructor(private opts: TelegramConnectorOptions) {
    this.offKernel = opts.kernel.onEvent((e) => {
      if (e.kind !== "task.status_changed" && e.kind !== "run.paused") return;
      void this.maybeReply(e.taskId, e.kind).catch((err) => this.log(`回帖失败 #${e.taskId}：${errText(err)}`));
    });
  }

  close(): void {
    this.offKernel();
  }

  private log(msg: string): void {
    this.opts.log?.(`[telegram] ${msg}`);
  }

  /** 处理单条 update：去重 → 文本消息 → 建任务自动跑 */
  handleUpdate(update: TelegramUpdate | unknown): void {
    const u = update as { update_id?: number };
    if (typeof u?.update_id === "number") {
      if (this.seenUpdateIds.has(u.update_id)) {
        this.log(`重复 update，忽略：${u.update_id}`);
        return;
      }
      this.seenUpdateIds.add(u.update_id);
      if (this.seenUpdateIds.size > MAX_SEEN_UPDATES) {
        this.seenUpdateIds.delete(this.seenUpdateIds.values().next().value as number);
      }
    }
    const msg = parseTelegramUpdate(update);
    if (!msg) {
      this.log(`忽略非任务消息（update_id=${u?.update_id}）`);
      return;
    }
    const taskId = this.opts.kernel.createTask({
      title: msg.text.slice(0, 24) || "TG 任务",
      brief: msg.text,
      budgetUsd: this.opts.defaultBudgetUsd ?? 3,
      source: `${SOURCE_PREFIX}${msg.chatId}:${msg.senderId}`,
    });
    this.log(`任务 #${taskId} 来自 chat ${msg.chatId}（${msg.text.slice(0, 30)}…）`);
    void this.opts.kernel.runTask(taskId).catch((err) => {
      this.log(`runTask #${taskId} 意外失败：${errText(err)}`);
    });
  }

  /** 轮询一轮：取更新逐条处理，返回下一个 offset（update_id 最大值 + 1） */
  async pollOnce(client: TelegramClient, offset: number): Promise<number> {
    const updates = await client.getUpdates(offset);
    let next = offset;
    for (const u of updates) {
      this.handleUpdate(u);
      if (u.update_id >= next) next = u.update_id + 1;
    }
    return next;
  }

  /** 任务终态/熔断 → 回帖到来源会话（source 落在 task.created payload，重启也能找回） */
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

  private replyClient?: TelegramClient;

  /** 回帖客户端可在凭据就绪后注入（构造时未给也能先收任务） */
  attachClient(client: TelegramClient): void {
    this.replyClient = client;
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

/** 长轮询主循环：错误如实打日志不中断（Telegram 会长时间无更新，属正常）。返回 stop() 供测试/关停 */
export function startTelegramPolling(opts: {
  client: TelegramClient;
  connector: TelegramConnector;
  log?: (msg: string) => void;
  intervalMs?: number;
}): { stop: () => void } {
  let offset = 0;
  let stopped = false;
  const interval = opts.intervalMs ?? 1000;
  const loop = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      try {
        offset = await opts.connector.pollOnce(opts.client, offset);
      } catch (err) {
        opts.log?.(`轮询失败（将继续）：${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  };
  void loop();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
