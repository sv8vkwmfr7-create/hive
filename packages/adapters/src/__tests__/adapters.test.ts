import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { HiveKernel, replayTask } from "@hive/kernel";
import type { TeamChart } from "@hive/shared";
import { loadAdapter, getPath, buildPrompt, extractJson, createAdapterResolver } from "../index.js";
import type { TaskPack, ProtocolMsg } from "../index.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesDir = join(pkgRoot, "fixtures");
const realAdaptersDir = join(pkgRoot, "adapters");

test("三份真引擎契约（codex / claude-code / deepseek）通过 schema 校验", () => {
  for (const id of ["codex", "claude-code", "deepseek"]) {
    const c = loadAdapter(join(realAdaptersDir, `${id}.json`));
    assert.equal(c.adapter, id);
    assert.equal(c.contract_version, 1);
    if (c.kind === "cli") assert.ok(c.spawn?.includes("stdin") || c.stdin_prompt, "cli 契约应有 spawn 且注明 stdin 送 prompt");
    if (c.kind === "api") {
      assert.ok(c.base_url);
      assert.ok(c.env_key);
      assert.ok(c.model);
    }
    if (c.mode === "codex_jsonl") assert.ok(c.final_items);
  }
});

test("坏契约被拒：cli 缺 spawn / api 缺 env_key / codex_jsonl 缺 final_items", () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-bad-contract-"));
  const cases: Array<[string, unknown, RegExp]> = [
    [
      "cli-no-spawn",
      { adapter: "x", kind: "cli", mode: "claude_json", contract_version: 1 },
      /spawn/,
    ],
    [
      "api-no-env",
      { adapter: "x", kind: "api", mode: "openai_chat", contract_version: 1, base_url: "https://x/v1", model: "m" },
      /env_key/,
    ],
    [
      "codex-no-items",
      { adapter: "x", kind: "cli", mode: "codex_jsonl", contract_version: 1, spawn: "foo" },
      /final_items/,
    ],
  ];
  for (const [name, body, expect] of cases) {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(body));
    assert.throws(() => loadAdapter(file), expect, name);
  }
});

test("jsonPath-lite：绝对/相对/数组下标", () => {
  const doc = { a: { b: [{ c: 42 }] }, usage: { input_tokens: 9 } };
  assert.equal(getPath(doc, "$.a.b[0].c"), 42);
  assert.equal(getPath(doc, "$.usage.input_tokens"), 9);
  assert.equal(getPath(doc, "input_tokens"), undefined, "对象上没有的相对路径 → undefined");
  assert.equal(getPath({ input_tokens: 9 }, "input_tokens"), 9, "scan 后的相对路径求值");
});

test("prompt 构建：治理规则、协议格式、上游产物齐全", () => {
  const pack: TaskPack = {
    taskId: "7",
    botId: "writer",
    role: "specialist",
    instruction: "写初稿",
    artifactDir: "unused",
    inputArtifacts: [{ botId: "researcher", path: "fixtures/fake-team.json" }],
  };
  const p = buildPrompt(pack, "deepseek");
  assert.match(p, /「writer」/);
  assert.match(p, /三要素/);
  assert.match(p, /只输出一个 JSON 对象/);
  assert.match(p, /fake-team/, "上游产物内容应进 prompt");
  const pr = buildPrompt({ ...pack, role: "reviewer" }, "codex");
  assert.match(pr, /PASS \/ BLOCK/, "审核员 prompt 应含判定规则");
});

test("extractJson：代码块 / 裸 JSON / 垃圾输入", () => {
  assert.deepEqual(extractJson('```json\n{"say":"x"}\n```'), { say: "x" });
  assert.deepEqual(extractJson('前言 {"say":"y"} 后记'), { say: "y" });
  assert.equal(extractJson("完全不是 JSON"), null);
  assert.equal(extractJson(""), null);
});

/** 直接 spawn 桥接 worker（不经内核），验证协议消息输出 */
function runBridgeWorker(contractPath: string, pack: TaskPack): Promise<{ code: number | null; msgs: ProtocolMsg[]; stderr: string }> {
  return new Promise((resolve) => {
    const bridgePath = join(pkgRoot, "dist", "bridgeWorker.js");
    const child = spawn(process.execPath, [bridgePath, contractPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("close", (code) => {
      const msgs = stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ProtocolMsg);
      resolve({ code, msgs, stderr });
    });
    child.stdin.write(JSON.stringify(pack) + "\n");
    child.stdin.end();
  });
}

test("桥接 worker 直连：claude_json 模式（离线假引擎）产出完整协议消息", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-bridge-claude-"));
  const contract = {
    adapter: "fake-claude",
    kind: "cli",
    mode: "claude_json",
    contract_version: 1,
    spawn: `node "${join(fixturesDir, "fake-claude-engine.mjs")}"`,
    stdin_prompt: true,
    usage_parse: {
      final_text: "$.result",
      usd: "$.total_cost_usd",
      tokens_in: "$.usage.input_tokens",
      tokens_out: "$.usage.output_tokens",
    },
    on_unparseable: "fail",
    timeout_ms: 30000,
  };
  const contractPath = join(dir, "fake-claude.json");
  writeFileSync(contractPath, JSON.stringify(contract));
  const artifactDir = mkdtempSync(join(tmpdir(), "hive-bridge-artifacts-"));

  const { code, msgs, stderr } = await runBridgeWorker(contractPath, {
    taskId: "s1",
    botId: "writer",
    role: "specialist",
    instruction: "冒烟",
    artifactDir,
    inputArtifacts: [],
  });

  assert.equal(code, 0, `应成功退出，stderr=${stderr}`);
  assert.ok(msgs.some((m) => m.type === "output" && m.chunk.includes("claude_json 模式冒烟成功")));
  const artifact = msgs.find((m) => m.type === "artifact") as { path: string } | undefined;
  assert.ok(artifact && existsSync(artifact.path), "桥应落盘产物文件");
  assert.ok(msgs.some((m) => m.type === "handoff" && m.to === "writer"));
  const usage = msgs.find((m) => m.type === "usage") as { tokensIn?: number; usd: number } | undefined;
  assert.equal(usage?.usd, 0.01, "usd 走契约的 $.total_cost_usd 路径");
  assert.equal(usage?.tokensIn, 100);
});

test("E2E 离线：假 codex(cli) + 假 DeepSeek(api) 经桥接跑通完整任务闭环", async () => {
  // 1. 假 OpenAI 兼容服务器（按 bot 角色回不同协议 JSON）
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const prompt = (JSON.parse(body).messages?.[0]?.content as string) ?? "";
      let reply: Record<string, unknown>;
      if (prompt.includes("「researcher」")) {
        reply = {
          say: "素材完成",
          artifact: { filename: "researcher-素材.md", content: "# 素材\n- 要点 1\n- 要点 2" },
          handoff: { to: "writer", note: { reason: "素材产出完成", progress: "v1", ask: "成稿" } },
        };
      } else if (prompt.includes("「writer」")) {
        reply = {
          say: "初稿完成",
          artifact: { filename: "writer-初稿.md", content: "# 初稿\n基于素材写成的简报正文。" },
          handoff: { to: "reviewer", note: { reason: "初稿完成", progress: "v1", ask: "独立审核" } },
        };
      } else {
        reply = { say: "角色未识别" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(reply) } }],
          usage: { prompt_tokens: 1200, completion_tokens: 640 },
        }),
      );
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;

  // 2. 临时契约目录：假 codex（fixtures 引擎）+ 假 deepseek（指向本地假 API）
  const dir = mkdtempSync(join(tmpdir(), "hive-adapter-e2e-"));
  const fakeCodex = JSON.parse(readFileSync(join(fixturesDir, "fake-codex.json"), "utf8")) as Record<string, unknown>;
  fakeCodex.spawn = `node "${join(fixturesDir, "fake-codex-engine.mjs")}"`;
  writeFileSync(join(dir, "fake-codex.json"), JSON.stringify(fakeCodex));
  writeFileSync(
    join(dir, "fake-deepseek.json"),
    JSON.stringify({
      adapter: "fake-deepseek",
      kind: "api",
      mode: "openai_chat",
      contract_version: 1,
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "deepseek-chat",
      env_key: "DEEPSEEK_API_KEY",
      usage_parse: { tokens_in: "$.usage.prompt_tokens", tokens_out: "$.usage.completion_tokens" },
      pricing: { input_per_mtok: 0.27, output_per_mtok: 1.1 },
      on_unparseable: "fail",
      timeout_ms: 30000,
    }),
  );
  process.env.DEEPSEEK_API_KEY = "offline-fake";

  // 3. 内核 + 适配器解析器 + 假团队 chart
  const chart = JSON.parse(readFileSync(join(fixturesDir, "fake-team.json"), "utf8"));
  const resolver = createAdapterResolver({ adaptersDir: dir });
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-adapter-data-")), chart, workers: resolver });

  try {
    const taskId = kernel.createTask({ title: "适配器链路验证", brief: "调研并产出一份简报", budgetUsd: 10 });
    const res = await kernel.runTask(taskId);
    assert.equal(res.status, "ok", `期望 ok，实际 ${res.status}：${res.reason ?? ""}`);

    const rp = replayTask(kernel.store, taskId);
    const costs = rp.receipt.entries;
    assert.equal(costs.length, 4, "4 个 bot 都应记账");
    assert.ok(costs.some((c) => c.engine === "fake-codex"), "cli 桥（假 codex）应记账");
    assert.ok(costs.some((c) => c.engine === "fake-deepseek"), "api 桥（假 DeepSeek）应记账");
    // cli 桥 usage 来自 codex_jsonl 扫描：950 in / 220 out → pricing 1.75/14
    const chief = costs.find((c) => c.botId === "chief")!;
    assert.equal(chief.tokensIn, 950);
    assert.equal(chief.tokensOut, 220);
    assert.ok(Math.abs(chief.usd - (950 / 1e6) * 1.75 - (220 / 1e6) * 14) < 1e-9, "pricing 牌价估算应正确");
    // api 桥 usage 来自响应 usage 字段：1200/640 → pricing 0.27/1.1
    const researcher = costs.find((c) => c.botId === "researcher")!;
    assert.equal(researcher.tokensIn, 1200);
    assert.ok(Math.abs(researcher.usd - (1200 / 1e6) * 0.27 - (640 / 1e6) * 1.1) < 1e-9);

    // 产物：chief + researcher + writer 各一份，且真实存在
    const artifactEvents = rp.timeline.filter((t) => t.kind === "artifact.produced");
    assert.equal(artifactEvents.length, 3);
    for (const a of artifactEvents) assert.ok(existsSync((a.payload as { path: string }).path));

    const verdict = rp.timeline.find((t) => t.kind === "review.verdict");
    assert.equal((verdict!.payload as { verdict: string }).verdict, "PASS", "审核 PASS 来自假 codex 的协议 JSON");
  } finally {
    // 无论断言成败都要拆干净，否则 keep-alive 连接挂住事件循环，测试进程永不退出
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("未知适配器 → 内核如实失败，不冒充可用", async () => {
  const chart: TeamChart = {
    schema_version: 1,
    team: "lonely",
    roles: [
      {
        id: "chief",
        name: "总管",
        kind: "orchestrator",
        engine: { type: "cli", adapter: "nonexistent" },
        profile: "profiles/总管.md",
        guards: { can_initiate_mention: true, daily_budget_usd: 1 },
      },
    ],
    handoffs: [],
  };
  const resolver = createAdapterResolver({ adaptersDir: mkdtempSync(join(tmpdir(), "hive-empty-adapters-")) });
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-unknown-")), chart, workers: resolver });
  const taskId = kernel.createTask({ title: "未知引擎", brief: "应如实失败", budgetUsd: 1 });
  const res = await kernel.runTask(taskId);
  assert.equal(res.status, "failed");
  assert.match(res.reason ?? "", /适配器尚未接入/);
  const errors = kernel.store.replayTaskEvents(taskId).filter((e) => e.kind === "error.reported");
  assert.equal(errors.length, 1);
});

test("buildPrompt：共享大脑——有库列条目促查库，无库说明自动落库", () => {
  const base: TaskPack = {
    taskId: "1",
    botId: "chief",
    role: "orchestrator",
    instruction: "写竞品简报",
    artifactDir: "/tmp/x",
    inputArtifacts: [],
    handoffs: [{ to: "researcher", when: "任务含调研子项" }],
  };
  const withVault = buildPrompt({ ...base, vault: [{ name: "task-7-竞品简报.md" }, { name: "task-3-定价研究.md" }] }, "deepseek");
  assert.match(withVault, /团队知识库（共享大脑）已有条目/);
  assert.match(withVault, /task-7-竞品简报\.md/);
  assert.match(withVault, /不要重做/);

  const emptyVault = buildPrompt({ ...base, vault: [] }, "deepseek");
  assert.match(emptyVault, /当前为空/);
  assert.match(emptyVault, /自动落库/);

  const noVaultField = buildPrompt(base, "deepseek");
  assert.match(noVaultField, /当前为空/, "未传 vault 视为空库");
});

test("E2E：API 引擎请求审批 → 内核挂起 → approveTask 带 approvals 重跑 → ok", async () => {
  // 状态化假 OpenAI 兼容服务器：按角色与批准状态回不同协议 JSON
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const prompt = (JSON.parse(body).messages?.[0]?.content as string) ?? "";
      let reply: Record<string, unknown>;
      if (prompt.includes("角色类型：orchestrator")) {
        reply = { say: "派外发任务", handoff: { to: "worker", note: { reason: "外发", progress: "派单", ask: "执行外发" } } };
      } else if (prompt.includes("角色类型：reviewer")) {
        reply = { say: "审核通过", verdict: { verdict: "PASS", evidence: "产物完整" } };
      } else if (prompt.includes("已获 CEO 批准")) {
        reply = {
          say: "已外发（批准后重跑）",
          artifact: { filename: "外发报告.md", content: "# 外发报告\n（已获 CEO 批准后产出）" },
          handoff: { to: "reviewer", note: { reason: "外发完成", progress: "v1", ask: "独立审核" } },
        };
      } else {
        reply = { say: "高风险动作需要审批", approval: { action: "send_external", risk: "high" } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(reply) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as AddressInfo).port;

  const dir = mkdtempSync(join(tmpdir(), "hive-approval-e2e-"));
  writeFileSync(
    join(dir, "fake-api.json"),
    JSON.stringify({
      adapter: "fake-api",
      kind: "api",
      mode: "openai_chat",
      contract_version: 1,
      base_url: `http://127.0.0.1:${port}/v1`,
      model: "fake-chat",
      env_key: "FAKE_API_KEY",
      usage_parse: { tokens_in: "$.usage.prompt_tokens", tokens_out: "$.usage.completion_tokens" },
      pricing: { input_per_mtok: 1, output_per_mtok: 2 },
      on_unparseable: "fail",
      timeout_ms: 30000,
    }),
  );

  const chart = {
    schema_version: 1,
    team: "appr-e2e",
    roles: [
      { id: "chief", name: "总管", kind: "orchestrator", engine: { type: "api", adapter: "fake-api" }, profile: "profiles/p.md", guards: { can_initiate_mention: true } },
      { id: "worker", name: "外发员", kind: "specialist", engine: { type: "api", adapter: "fake-api" }, profile: "profiles/p.md", guards: { can_initiate_mention: false, needs_approval_for: ["send_external"] } },
      { id: "reviewer", name: "审核员", kind: "reviewer", engine: { type: "api", adapter: "fake-api" }, profile: "profiles/p.md", guards: { can_initiate_mention: false } },
    ],
    handoffs: [
      { from: "chief", to: "worker", when: "派外发" },
      { from: "worker", to: "reviewer", when: "完成送审" },
    ],
  } as unknown as TeamChart;
  const resolver = createAdapterResolver({ adaptersDir: dir });
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-approval-data-")), chart, workers: resolver });
  process.env.FAKE_API_KEY = "offline-fake";
  try {
    const taskId = kernel.createTask({ title: "审批桥 E2E", brief: "外发需 CEO 批准", budgetUsd: 5 });
    const res1 = await kernel.runTask(taskId);
    assert.equal(res1.status, "paused", `worker 请求审批应挂起：${res1.reason ?? ""}`);
    assert.equal(kernel.pendingApproval(taskId), "send_external");
    assert.ok(!kernel.store.replayTaskEvents(taskId).some((e) => e.kind === "review.verdict"), "审批挂起时不应有结论");

    const res2 = await kernel.approveTask(taskId, "send_external", "CEO");
    assert.equal(res2.status, "ok", `批准后应 ok：${res2.reason ?? ""}`);
    const evs = kernel.store.replayTaskEvents(taskId);
    assert.ok(evs.some((e) => e.kind === "approval.requested"));
    assert.ok(evs.some((e) => e.kind === "approval.granted"));
    assert.ok(kernel.store.replayTaskEvents(taskId).some((e) => e.kind === "artifact.produced"), "批准后重跑应产出外发 artifact");
    assert.ok(evs.some((e) => e.kind === "review.verdict"), "重跑后仍走独立审核");
  } finally {
    delete process.env.FAKE_API_KEY;
    server.close();
  }
});
