import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEvent } from "@hive/shared";
import { HiveKernel, EventStore, replayTask } from "../index.js";
import type { StoredEvent } from "../index.js";

const hiveRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const mockChart = JSON.parse(readFileSync(join(hiveRoot, "teams/mock-team.json"), "utf8"));

const tmpDataDir = () => mkdtempSync(join(tmpdir(), "hive-kernel-"));

const kinds = (events: StoredEvent[]) => events.map((e) => e.kind);

test("E2E：mock 团队跑通第一个本地任务闭环，全事件可回放，账单落盘", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });

  const live: StoredEvent[] = [];
  kernel.onEvent((e) => live.push(e));

  const taskId = kernel.createTask({ title: "竞品简报", brief: "写一份竞品研究简报", budgetUsd: 5, source: "local-test" });
  const res = await kernel.runTask(taskId);

  assert.equal(res.status, "ok", `期望 ok，实际 ${res.status}：${res.reason ?? ""}`);
  assert.ok(res.receipt);
  assert.ok(Math.abs(res.receipt.totalUsd - 0.5) < 1e-9, `账单应为 $0.50，实际 ${res.receipt.totalUsd}`);

  // 账单落盘（工资单）
  const receiptPath = join(dataDir, "ledger", `task-${taskId}.receipt.json`);
  assert.ok(existsSync(receiptPath), "账单小票应写盘");
  const onDisk = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(onDisk.taskId, taskId);

  // 事件时间线：闭环关键节点齐全
  const events = kernel.store.replayTaskEvents(taskId);
  const k = kinds(events);
  assert.ok(k.includes("task.created"));
  assert.ok(k.includes("task.assigned"));
  assert.equal(k.filter((x) => x === "bot.spawned").length, 4, "4 个 bot 都应被 spawn");
  assert.equal(k.filter((x) => x === "handoff.created").length, 3, "chief→researcher→writer→reviewer 三次交接");
  assert.equal(k.filter((x) => x === "artifact.produced").length, 2, "素材 + 初稿");
  assert.equal(k.filter((x) => x === "cost.recorded").length, 4, "4 笔成本记账");
  const verdict = events.find((e) => e.kind === "review.verdict");
  assert.equal((verdict!.payload as { verdict: string }).verdict, "PASS");
  const statusChange = events.filter((e) => e.kind === "task.status_changed");
  assert.equal((statusChange.at(-1)!.payload as { to: string }).to, "ok");

  // 产物真实存在
  for (const e of events.filter((e) => e.kind === "artifact.produced")) {
    assert.ok(existsSync((e.payload as { path: string }).path), `产物应存在：${(e.payload as { path: string }).path}`);
  }

  // 事件溯源完整性：JSONL 与 SQLite 行数一致；全部事件过 shared 校验；seq 单调
  const jsonlLines = readFileSync(join(dataDir, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  assert.equal(jsonlLines.length, kernel.store.count(), "JSONL 行数应等于 SQLite 索引行数");
  let lastSeq = -1;
  for (const line of jsonlLines) {
    const parsed = parseEvent(JSON.parse(line));
    assert.equal(parsed.known, true, "所有事件应为已知类型");
    assert.ok(parsed.event.seq > lastSeq, "seq 应严格递增");
    lastSeq = parsed.event.seq;
  }

  // 回放审计：replayTask 重建的时间线与账单和事件一致
  const rp = replayTask(kernel.store, taskId);
  assert.equal(rp.eventCount, events.length);
  assert.ok(Math.abs(rp.receipt.totalUsd - res.receipt.totalUsd) < 1e-9);
  assert.equal(rp.timeline.at(-1)!.glyph, "✅", "最后一笔状态应为 ✅");

  // 实时订阅与落盘一致
  assert.equal(live.length, events.length);
});

test("任务预算熔断：超限自动暂停，不硬烧，不谎报成功", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "穷任务", brief: "预算只有 $0.10", budgetUsd: 0.1 });
  const res = await kernel.runTask(taskId);

  assert.equal(res.status, "paused");
  assert.ok(kernel.isPaused(taskId));

  const k = kinds(kernel.store.replayTaskEvents(taskId));
  const exceeded = kernel.store.replayTaskEvents(taskId).find((e) => e.kind === "budget.exceeded");
  assert.ok(exceeded, "应有 budget.exceeded");
  assert.equal((exceeded!.payload as { limitUsd: number }).limitUsd, 0.1);
  assert.ok(k.includes("run.paused"));
  assert.ok(k.includes("cost.recorded"), "熔断前已花的钱要如实记账");
  assert.ok(!k.includes("review.verdict"), "审核员不应被派工");
  assert.ok(!k.includes("task.status_changed"), "暂停不是失败也不是成功");
  assert.ok(!existsSync(join(dataDir, "ledger", `task-${taskId}.receipt.json`)), "未交付不应出账单");
});

test("bot 日额度熔断 + 内核重启后预算从事件流重建", async () => {
  const dataDir = tmpDataDir();
  // 第一单：researcher 花掉 $0.20
  const kernel1 = new HiveKernel({ dataDir, chart: mockChart });
  const t1 = kernel1.createTask({ title: "第一单", brief: "正常预算", budgetUsd: 5 });
  const r1 = await kernel1.runTask(t1);
  assert.equal(r1.status, "ok");

  // 内核"重启"：新实例从同一事件流重建花费表
  const tightChart = JSON.parse(JSON.stringify(mockChart));
  tightChart.roles.find((r: { id: string }) => r.id === "researcher").guards.daily_budget_usd = 0.1;
  const kernel2 = new HiveKernel({ dataDir, chart: tightChart });
  const t2 = kernel2.createTask({ title: "第二单", brief: "研究员今天没钱了", budgetUsd: 5 });
  const r2 = await kernel2.runTask(t2);

  assert.equal(r2.status, "paused");
  const t2Events = kernel2.store.replayTaskEvents(t2);
  const researcherSpawns = t2Events.filter(
    (e) => e.kind === "bot.spawned" && (e.payload as { botId: string }).botId === "researcher",
  );
  assert.equal(researcherSpawns.length, 0, "研究员日额度用尽，不应再 spawn");
  const exceeded = t2Events.find((e) => e.kind === "budget.exceeded");
  assert.ok(exceeded);
  assert.equal((exceeded!.payload as { limitUsd: number }).limitUsd, 0.1);
  // 任务级预算没用完（总管花了 $0.05 < $5），所以熔断原因是 bot 日额度
  assert.match((exceeded!.payload as unknown as { usedUsd: number }).usedUsd.toFixed(2), /0\.20/);
});

test("门禁：handoff 无 chart 边 → 内核拒绝并如实失败", async () => {
  const dataDir = tmpDataDir();
  const rogueChart = JSON.parse(JSON.stringify(mockChart));
  // 总管换成 rogue 引擎：该 worker 故意发出 chart 外的交接（ghost-bot）
  rogueChart.roles.find((r: { id: string }) => r.id === "chief").engine.adapter = "rogue";
  const kernel = new HiveKernel({
    dataDir,
    chart: rogueChart,
    workers: (id) =>
      id === "rogue" ? { workerPath: join(hiveRoot, "packages/kernel/src/__tests__/fixtures/rogue-worker.mjs") } : null,
  });
  const taskId = kernel.createTask({ title: "越权交接", brief: "bot 试图绕过 chart", budgetUsd: 5 });
  const res = await kernel.runTask(taskId);

  assert.equal(res.status, "failed");
  assert.match(res.reason ?? "", /非法交接|无此边/);
  const errors = kernel.store.replayTaskEvents(taskId).filter((e) => e.kind === "error.reported");
  assert.ok(errors.length >= 1);
  assert.match((errors[0].payload as { message: string }).message, /无此边/);
  const k = kinds(kernel.store.replayTaskEvents(taskId));
  assert.ok(!k.includes("review.verdict"), "流程不应继续到审核");
});

test("store 校验：非法 payload（BLOCK 无证据）不落库", () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "记账冒烟", brief: "验证 store 校验", budgetUsd: 1 });
  // 角色门禁（非审核员不得出结论）在内核层，由上面的越权测试覆盖；
  // store 这一层负责：payload 结构不过（BLOCK 无证据）绝不入账。
  assert.throws(
    () => kernel.store.append({ taskId, actor: "reviewer", kind: "review.verdict", payload: { verdict: "BLOCK" } }),
    /校验失败/,
  );
  assert.equal(kernel.store.count(), 1, "只有 task.created 落库");
});

test("共享大脑：任务 PASS 后交付摘要自动落 vault（产物全文 + 账单内嵌）", async () => {
  const dataDir = tmpDataDir();
  const vaultDir = mkdtempSync(join(tmpdir(), "hive-vault-"));
  const kernel = new HiveKernel({ dataDir, chart: mockChart, vaultDir });
  const taskId = kernel.createTask({ title: "落库验证", brief: "交付摘要自动写进知识库", budgetUsd: 5 });
  const res = await kernel.runTask(taskId);

  assert.equal(res.status, "ok");
  assert.ok(res.vaultPath, "应返回 vault 落库路径");
  assert.ok(res.vaultPath!.includes("蜂巢交付"), "落库目录应为 vault/蜂巢交付/");
  assert.ok(existsSync(res.vaultPath!), "落库文件应存在");

  const digest = readFileSync(res.vaultPath!, "utf8");
  assert.match(digest, /title: 落库验证/, "frontmatter 标题");
  assert.match(digest, /## 账单/, "账单段落");
  assert.match(digest, /cost_usd: 0\.5/, "总额在 frontmatter（mock 固定 $0.50）");
  assert.match(digest, /## 交付物/, "交付物段落");
  assert.match(digest, /## 产出/, "产物全文应内嵌");
  assert.match(digest, /chief → researcher/, "流转记录");
});

test("共享大脑：未配 vaultDir 不落库，RunResult 无 vaultPath", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "无库任务", brief: "不落库", budgetUsd: 5 });
  const res = await kernel.runTask(taskId);
  assert.equal(res.status, "ok");
  assert.equal(res.vaultPath, undefined);
});

test("CEO 门 ⏸️/▶️：运行中暂停停在蜂房边界，恢复续跑至交付", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "暂停续跑", brief: "人工控制流", budgetUsd: 5 });

  // 起跑不 await，第一只蜂被 spawn 后按下暂停
  const running = kernel.runTask(taskId);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (kernel.store.replayTaskEvents(taskId).some((e) => e.kind === "bot.spawned")) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  kernel.pauseTask(taskId, "CEO");
  const res = await running;
  assert.equal(res.status, "paused");
  assert.match(res.reason ?? "", /人工暂停/);

  const spawnedMid = kernel.store.replayTaskEvents(taskId).filter((e) => e.kind === "bot.spawned");
  assert.ok(spawnedMid.length < 4, `暂停时应未跑完 4 蜂，实际 ${spawnedMid.length}`);
  assert.ok(
    !spawnedMid.some((e) => (e.payload as { botId: string }).botId === "reviewer"),
    "审核员不应在暂停前被派工",
  );

  const resumed = await kernel.resumeTask(taskId, "CEO");
  assert.equal(resumed.status, "ok", `恢复后应 ok：${resumed.reason ?? ""}`);
  assert.ok(resumed.receipt);
  const allSpawns = kernel.store.replayTaskEvents(taskId).filter((e) => e.kind === "bot.spawned");
  assert.equal(allSpawns.length, 4, "恢复后 4 蜂全部跑完");
  const k = kinds(kernel.store.replayTaskEvents(taskId));
  assert.ok(k.includes("run.paused"));
  assert.ok(k.includes("run.resumed"));
});

test("CEO 门 ⏸️ 先于执行：一次蜂都不 spawn，恢复后完整交付", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "先停后跑", brief: "暂停先于执行", budgetUsd: 5 });
  kernel.pauseTask(taskId, "CEO");
  const res = await kernel.runTask(taskId);
  assert.equal(res.status, "paused");
  assert.equal(kernel.store.replayTaskEvents(taskId).filter((e) => e.kind === "bot.spawned").length, 0);
  const resumed = await kernel.resumeTask(taskId);
  assert.equal(resumed.status, "ok");
});

test("CEO 门 ✋ 接管：暂停后人工派工生效；越权与未暂停如实拒绝", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "接管派工", brief: "CEO 直接派给写手", budgetUsd: 5 });
  kernel.pauseTask(taskId, "CEO");
  await kernel.runTask(taskId); // 立即停在第一边界

  const other = kernel.createTask({ title: "未暂停任务", brief: "x", budgetUsd: 5 });
  assert.throws(() => kernel.instructTask(other, "writer", "x"), /不在人工暂停态/, "未暂停不可接管");
  assert.throws(() => kernel.instructTask(taskId, "ghost-bot", "x"), /无此 bot/, "架构图外的 bot 拒绝");
  assert.throws(() => kernel.instructTask(taskId, "writer", "  "), /指令不能为空/, "空指令拒绝");

  kernel.instructTask(taskId, "writer", "CEO 指令：直接基于简报写终稿", "CEO");
  const resumed = await kernel.resumeTask(taskId, "CEO");
  assert.equal(resumed.status, "ok", `接管后应跑通：${resumed.reason ?? ""}`);
  const spawned = kernel.store
    .replayTaskEvents(taskId)
    .filter((e) => e.kind === "bot.spawned")
    .map((e) => (e.payload as { botId: string }).botId);
  assert.equal(spawned[0], "writer", "接管派工的蜂应第一个被 spawn");
  assert.ok(spawned.includes("reviewer"), "接管后流程仍走独立审核");
});

test("CEO 门：无可恢复队列时如实拒绝", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "无可恢复", brief: "从未暂停", budgetUsd: 5 });
  const res = await kernel.resumeTask(taskId);
  assert.equal(res.status, "failed");
  assert.match(res.reason ?? "", /无可恢复/);
});

test("审批门：高风险动作挂起待批 → 批准后重跑该蜂直至 PASS 交付", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "审批门", brief: "send_external 需 CEO 批准", budgetUsd: 5 });
  process.env.HIVE_MOCK_APPROVAL = "send_external";
  try {
    const res = await kernel.runTask(taskId);
    assert.equal(res.status, "paused");
    assert.match(res.reason ?? "", /等待审批/);
    assert.equal(kernel.pendingApproval(taskId), "send_external");
    assert.ok(kernel.store.replayTaskEvents(taskId).some((e) => e.kind === "approval.requested"), "应有 approval.requested");
    assert.equal(kernel.isPaused(taskId), true);

    await assert.rejects(() => kernel.approveTask(taskId, "wrong_action", "CEO"), /待批动作是/, "批错动作如实拒绝");

    const res2 = await kernel.approveTask(taskId, "send_external", "CEO");
    assert.equal(res2.status, "ok", `批准后应跑通：${res2.reason ?? ""}`);
    assert.equal(kernel.pendingApproval(taskId), null);
    const reviewerSpawns = kernel.store.replayTaskEvents(taskId).filter(
      (e) => e.kind === "bot.spawned" && (e.payload as { botId: string }).botId === "reviewer",
    );
    assert.ok(reviewerSpawns.length >= 2, "批准后 reviewer 应重跑");
    const k = kinds(kernel.store.replayTaskEvents(taskId));
    assert.ok(k.includes("approval.granted"));
    assert.ok(k.includes("run.resumed"));
  } finally {
    delete process.env.HIVE_MOCK_APPROVAL;
  }
});

test("审批门：拒绝 → 任务如实失败，不放行", async () => {
  const dataDir = tmpDataDir();
  const kernel = new HiveKernel({ dataDir, chart: mockChart });
  const taskId = kernel.createTask({ title: "审批拒绝", brief: "拒绝外发", budgetUsd: 5 });
  process.env.HIVE_MOCK_APPROVAL = "send_external";
  try {
    const res = await kernel.runTask(taskId);
    assert.equal(res.status, "paused");

    kernel.denyTask(taskId, "send_external", "CEO", "不允许对外发送");
    const k = kinds(kernel.store.replayTaskEvents(taskId));
    assert.ok(k.includes("approval.denied"));
    const last = kernel.store.replayTaskEvents(taskId).filter((e) => e.kind === "task.status_changed").at(-1);
    assert.equal((last!.payload as { to: string }).to, "failed");
    assert.match((last!.payload as { reason: string }).reason, /审批被拒/);
    assert.equal(kernel.pendingApproval(taskId), null);
    assert.equal(existsSync(join(dataDir, "ledger", `task-${taskId}.receipt.json`)), false, "被拒任务不出账单");

    const r = await kernel.resumeTask(taskId);
    assert.equal(r.status, "failed");
    assert.match(r.reason ?? "", /无可恢复/, "拒绝后队列已清空，不可续跑");
  } finally {
    delete process.env.HIVE_MOCK_APPROVAL;
  }
});
