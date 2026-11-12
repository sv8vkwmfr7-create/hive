import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { EventEnvelope, parseEvent, STATUS_GLYPH } from "../events.js";
import { HandoffNote, ReviewVerdict, GOVERNANCE, normalizeVerdictInput } from "../handoff.js";
import { TeamChartSchema, validateChart, importAgentOrgChart } from "../org-chart.js";
import { summarizeReceipt } from "../ledger.js";

const here = dirname(fileURLToPath(import.meta.url)); // dist/__tests__
const hiveRoot = join(here, "../../../..");
const teamSample = JSON.parse(readFileSync(join(hiveRoot, "teams/research-team.json"), "utf8"));

const baseEvent = {
  seq: 0,
  id: crypto.randomUUID(),
  ts: new Date().toISOString(),
  taskId: "142",
  actor: "chief",
};

test("事件信封：合法事件通过并校验 payload", () => {
  const r = parseEvent({
    ...baseEvent,
    kind: "task.assigned",
    payload: { from: "chief", to: "researcher", instruction: "调研竞品" },
  });
  assert.equal(r.known, true);
  assert.equal(r.error, undefined);
  assert.equal(r.event.kind, "task.assigned");
});

test("事件信封：缺 seq / 坏 uuid 必须被拒", () => {
  assert.throws(() => EventEnvelope.parse({ ...baseEvent, seq: -1, id: "nope", kind: "run.resumed" }));
  assert.throws(() => EventEnvelope.parse({ ...baseEvent, id: "nope", kind: "run.resumed" }));
});

test("事件信封：未知 kind 放行（append-only 不丢历史）但标 known=false", () => {
  const r = parseEvent({ ...baseEvent, kind: "hoge.fuga", payload: { whatever: 1 } });
  assert.equal(r.known, false);
  assert.equal(r.error, undefined);
});

test("事件 payload：task.status_changed 只收 ok/running/failed", () => {
  const bad = parseEvent({ ...baseEvent, kind: "task.status_changed", payload: { to: "done" } });
  assert.ok(bad.error, "非法状态应报错");
  const good = parseEvent({ ...baseEvent, kind: "task.status_changed", payload: { to: "ok" } });
  assert.equal(good.error, undefined);
});

test("状态标记映射 ✅/🔄/⛔", () => {
  assert.deepEqual(STATUS_GLYPH, { ok: "✅", running: "🔄", failed: "⛔" });
});

test("交接三要素缺一不可", () => {
  assert.throws(() => HandoffNote.parse({ reason: "素材齐备", progress: "80%" })); // 缺 ask
  const ok = HandoffNote.parse({ reason: "素材齐备", progress: "素材 v2 已产出", ask: "请成稿" });
  assert.equal(ok.ask, "请成稿");
});

test("审核结论：BLOCK 无证据非法，PASS/HOLD 合法路径正确", () => {
  assert.throws(() => ReviewVerdict.parse({ verdict: "BLOCK" }));
  const hold = ReviewVerdict.parse({ verdict: "HOLD", reason: "等数据补齐" });
  assert.equal(hold.verdict, "HOLD");
});

test("verdict 字段错位纠偏：HOLD 配 evidence / BLOCK 配 reason 就地回退，纠偏后过校验", () => {
  // 真实首跑抓到的失败模式（Telegram 任务 #1）：reviewer 给了 HOLD + evidence
  const fixed = normalizeVerdictInput({ verdict: "HOLD", evidence: "初稿空泛，待补主题" });
  assert.deepEqual(fixed, { verdict: "HOLD", reason: "初稿空泛，待补主题" });
  assert.ok(ReviewVerdict.safeParse(fixed).success, "纠偏后应过 ReviewVerdict");

  const fixedBlock = normalizeVerdictInput({ verdict: "BLOCK", reason: "数据造假，无出处" });
  assert.deepEqual(fixedBlock, { verdict: "BLOCK", evidence: "数据造假，无出处" });
  assert.ok(ReviewVerdict.safeParse(fixedBlock).success, "BLOCK 纠偏后应过校验");

  // 字段名没放错的原样通过；BLOCK 无任何说明纠偏后仍非法（store 硬门禁不放宽）
  assert.deepEqual(normalizeVerdictInput({ verdict: "PASS" }), { verdict: "PASS" });
  assert.deepEqual(normalizeVerdictInput({ verdict: "BLOCK", evidence: "有证据" }), { verdict: "BLOCK", evidence: "有证据" });
  assert.ok(!ReviewVerdict.safeParse(normalizeVerdictInput({ verdict: "BLOCK" })).success, "BLOCK 完全无说明依旧非法");
});

test("治理规则默认值正确", () => {
  assert.equal(GOVERNANCE.onlyOrchestratorInitiatesMention, true);
  assert.equal(GOVERNANCE.handoffIsNotApproval, true);
});

test("teams/research-team.json 通过 schema 与结构校验", () => {
  const chart = TeamChartSchema.parse(teamSample);
  assert.deepEqual(validateChart(chart), []);
});

test("validateChart 捕获：双总管 / handoff 引用不存在 / 审核员发起@", () => {
  const chart = TeamChartSchema.parse({
    ...teamSample,
    roles: [
      ...teamSample.roles,
      { ...teamSample.roles[0], id: "chief2" }, // 第二个总管
      { ...teamSample.roles[3], id: "rev2", guards: { can_initiate_mention: true } }, // 审核员发起@
    ],
    handoffs: [...teamSample.handoffs, { from: "ghost", to: "writer", when: "x" }], // ghost 不存在
  });
  const errors = validateChart(chart);
  assert.ok(errors.some((e) => e.includes("orchestrator")));
  assert.ok(errors.some((e) => e.includes("ghost")));
  assert.ok(errors.some((e) => e.includes("rev2")));
});

test("agent-org-chart 宽容导入：未知 kind 归 specialist + 警告，不丢额外字段", () => {
  const { chart, warnings } = importAgentOrgChart({
    id: "imported-team",
    roles: [
      { id: "boss", name: "Boss", kind: "lead", engine: { type: "cli", adapter: "codex" } },
      { id: "eyes", name: "Eyes", kind: "auditor", engine: { type: "api", adapter: "deepseek" } },
      { id: "hand", name: "Hand", kind: "weird-kind", engine: { type: "api", adapter: "deepseek" } },
    ],
    handoffs: [{ from: "boss", to: "hand", when: "需要执行" }],
    future_field: { whatever: true },
  });
  assert.equal(chart.roles.filter((r) => r.kind === "orchestrator").length, 1);
  assert.equal(chart.roles.find((r) => r.id === "hand")?.kind, "specialist");
  assert.ok(warnings.some((w) => w.includes("weird-kind")));
  assert.equal((chart as Record<string, unknown>).future_field != null, true);
  assert.deepEqual(validateChart(chart), []);
});

test("账本小票：汇总金额正确", () => {
  const receipt = summarizeReceipt("142", [
    { taskId: "142", botId: "researcher", engine: "deepseek", usd: 0.2, ts: new Date().toISOString() },
    { taskId: "142", botId: "writer", engine: "zcode", usd: 0.21, ts: new Date().toISOString() },
  ]);
  assert.ok(Math.abs(receipt.totalUsd - 0.41) < 1e-9);
});

test("导入社区真 chart（agent-org-chart schema v1）：三套全部 validateChart 通过", () => {
  const fixturesDir = join(hiveRoot, "packages/shared/src/__tests__/fixtures");
  for (const n of ["customer-support", "engineering", "game-studio"]) {
    const raw = JSON.parse(readFileSync(join(fixturesDir, `aoc-${n}.json`), "utf8"));
    const { chart, warnings } = importAgentOrgChart(raw);
    const errs = validateChart(chart);
    assert.equal(errs.length, 0, `${n} 导入后应合法：${errs.join(";")}`);
    assert.equal(chart.schema_version, 1);
    assert.equal(chart.team, n);
    const orch = chart.roles.filter((r) => r.kind === "orchestrator");
    assert.equal(orch.length, 1, `${n} 应恰好一个总管`);
    assert.ok(chart.handoffs.length >= chart.roles.length - 1, `${n} 应有派单边（reports_to 树合成或显式）`);
    // 平台无关图 → 引擎默认 mock
    for (const r of chart.roles) assert.equal(r.engine.adapter, "mock", `${n} 的 ${r.id} 默认 mock 引擎`);
  }
});

test("导入语义：无总管图合成「总管（导入）」，reports_to 树转派单边，channels 数组转 record", () => {
  const fixturesDir = join(hiveRoot, "packages/shared/src/__tests__/fixtures");
  // customer-support：0 orchestrator + 4 个根 specialist
  const cs = importAgentOrgChart(JSON.parse(readFileSync(join(fixturesDir, "aoc-customer-support.json"), "utf8")));
  assert.equal(cs.chart.roles.filter((r) => r.kind === "orchestrator").length, 1);
  const chief = cs.chart.roles.find((r) => r.id === "chief");
  assert.ok(chief, "应合成 chief 总管");
  assert.ok(cs.warnings.some((w) => w.includes("合成")), "应有合成警告");
  for (const id of ["build", "reply", "alert", "tune"]) {
    assert.ok(cs.chart.handoffs.some((h) => h.from === "chief" && h.to === id), `chief→${id} 派单边`);
  }
  // engineering：自带 orchestrator（engineering-manager），树边 manager→engineer
  const eng = importAgentOrgChart(JSON.parse(readFileSync(join(fixturesDir, "aoc-engineering.json"), "utf8")));
  assert.ok(!eng.warnings.some((w) => w.includes("已合成「总管")), "已有总管不应合成");
  assert.ok(eng.chart.handoffs.some((h) => h.from === "engineering-manager" && h.to === "engineer"), "reports_to 树边");
  // channels 数组 → record（game-studio 未必有 channels，构造一个最小样例验证）
  const { chart: withChannels } = importAgentOrgChart({
    schema_version: 1,
    id: "demo",
    roles: [
      { id: "a", name: "A", kind: "orchestrator", reports_to: null, in_scope: [], out_of_scope: [] },
      { id: "b", name: "B", kind: "specialist", reports_to: "a", in_scope: [], out_of_scope: [] },
    ],
    channels: [{ id: "ops", name: "作战频道", member_role_ids: ["a", "b"] }],
    handoffs: [{ from_role_id: "a", to_role_id: "b", when: "有活就派" }],
  });
  assert.deepEqual(withChannels.channels?.ops, { name: "作战频道", members: ["a", "b"] });
  assert.equal(withChannels.handoffs[0].from, "a", "from_role_id 归一为 from");
});
