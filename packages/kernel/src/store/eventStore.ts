import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { parseEvent } from "@hive/shared";
import type { EventEnvelope } from "@hive/shared";

/** 落盘的一条完整事件（信封 + payload） */
export interface StoredEvent extends EventEnvelope {
  payload: unknown;
}

/**
 * 事件溯源存储（硬原则 2：一切皆事件）。
 * - JSONL append-only：payload 的唯一真相源，只追加，永不改写
 * - SQLite（node:sqlite）：只做索引查询，不存 payload
 * 写入顺序：先 JSONL 后 SQLite——崩溃时最多丢索引行，不丢历史。
 */
export class EventStore {
  private db: DatabaseSync;
  private jsonlPath: string;
  private lastSeq = 0;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.jsonlPath = join(dataDir, "events.jsonl");
    if (existsSync(this.jsonlPath)) {
      for (const line of readFileSync(this.jsonlPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as { seq: number };
        this.lastSeq = Math.max(this.lastSeq, e.seq);
      }
    }
    this.db = new DatabaseSync(join(dataDir, "index.db"));
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        id TEXT UNIQUE,
        ts TEXT,
        task_id TEXT,
        actor TEXT,
        kind TEXT,
        known INTEGER
      )`,
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor)");
  }

  /**
   * 追加一条事件。payload 用 @hive/shared 校验：已知 kind 校验失败直接抛错（内核不落坏账）；
   * 未知 kind 放行并标 known=0（append-only 不丢历史）。
   * 单进程 MVP：seq 由内存计数器单调分配。
   */
  append(input: { taskId: string; actor: string; kind: string; payload: unknown }): StoredEvent {
    const seq = ++this.lastSeq;
    const envelope: EventEnvelope = {
      seq,
      id: randomUUID(),
      ts: new Date().toISOString(),
      taskId: input.taskId,
      actor: input.actor,
      kind: input.kind,
    };
    const parsed = parseEvent({ ...envelope, payload: input.payload });
    if (parsed.error) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`事件 payload 校验失败 kind=${input.kind}：${msg}`);
    }
    appendFileSync(this.jsonlPath, JSON.stringify({ ...envelope, payload: input.payload }) + "\n", "utf8");
    this.db
      .prepare("INSERT INTO events (seq,id,ts,task_id,actor,kind,known) VALUES (?,?,?,?,?,?,?)")
      .run(seq, envelope.id, envelope.ts, input.taskId, input.actor, input.kind, parsed.known ? 1 : 0);
    return { ...envelope, payload: input.payload };
  }

  /** 全量事件（JSONL，含 payload），按 seq 升序 = 追加顺序 */
  allEvents(): StoredEvent[] {
    if (!existsSync(this.jsonlPath)) return [];
    return readFileSync(this.jsonlPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as StoredEvent)
      .sort((a, b) => a.seq - b.seq);
  }

  /** 单个任务的事件时间线（回放审计的基础） */
  replayTaskEvents(taskId: string): StoredEvent[] {
    return this.allEvents().filter((e) => e.taskId === taskId);
  }

  /** SQLite 索引：行数（应恒等于 JSONL 行数，测试里互相印证） */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return row.c;
  }

  countKind(kind: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = ?").get(kind) as { c: number };
    return row.c;
  }
}
