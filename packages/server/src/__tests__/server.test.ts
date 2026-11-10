import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { HiveKernel } from "@hive/kernel";
import { createHiveServer } from "../index.js";

const hiveRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const chart = JSON.parse(readFileSync(join(hiveRoot, "teams/mock-team.json"), "utf8"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到 fn 返回真值（或超时返回最后值）；fn 可同步可异步 */
async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs: number, stepMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await sleep(stepMs);
  }
}

interface WsMsg {
  type: string;
  event?: { taskId: string; kind: string; payload: Record<string, unknown> };
}

test("server：HTTP API + 静态看板 + WebSocket 实时事件流", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-server-")), chart });
  const server = await createHiveServer({ kernel });
  const base = `http://127.0.0.1:${server.port}`;

  try {
    // 静态看板页
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /蜂巢看板/);
    const css = await (await fetch(`${base}/style.css`)).text();
    assert.match(css, /--accent/);
    // 静态路径穿越被拒
    const evil = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.ok([403, 404].includes(evil.status), "路径穿越应 403/404");

    // health + chart
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
    const { chart: gotChart } = await (await fetch(`${base}/api/chart`)).json();
    assert.equal(gotChart.team, "mock-team");

    // WS：连接先收快照。注意：监听器必须先挂再等 open——
    // 快照可能在 open 同一个 tick 里就到，后挂监听器会漏掉。
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const messages: WsMsg[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString()) as WsMsg));
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    await waitUntil(() => messages.some((m) => m.type === "snapshot"), 3000);
    const snap = messages.find((m) => m.type === "snapshot");
    assert.ok(snap, "连接后应先收到任务快照");

    // 发一单（POST /api/tasks 自动开跑），事件实时流经 WS
    const post = await (await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "看板首单", brief: "写一份竞品研究简报", budgetUsd: 5 }),
    })).json();
    assert.equal(post.accepted, true);
    const taskId = post.taskId;

    const sawOk = await waitUntil(
      () =>
        messages.some(
          (m) =>
            m.type === "event" &&
            m.event?.taskId === taskId &&
            m.event?.kind === "task.status_changed" &&
            m.event?.payload.to === "ok",
        ),
      15000,
    );
    assert.ok(sawOk, "应通过 WS 实时看到任务完成事件");
    const kinds = messages
      .filter((m) => m.type === "event" && m.event?.taskId === taskId)
      .map((m) => m.event!.kind);
    assert.ok(kinds.includes("task.created"), "WS 应实时推 task.created");
    assert.ok(kinds.includes("bot.output"), "WS 应实时推输出流");
    assert.ok(kinds.includes("cost.recorded"), "WS 应实时推记账事件");

    // 任务详情（回放时间线 + 账单）
    const detail = await (await fetch(`${base}/api/tasks/${taskId}`)).json();
    assert.equal(detail.status, "ok");
    assert.ok(detail.receipt.totalUsd > 0);
    assert.ok(detail.timeline.some((t: { kind: string }) => t.kind === "cost.recorded"));

    // 任务列表
    const { tasks } = (await (await fetch(`${base}/api/tasks`)).json()) as {
      tasks: Array<{ taskId: string; status: string; glyph: string }>;
    };
    const summary = tasks.find((t) => t.taskId === taskId);
    assert.equal(summary?.status, "ok");
    assert.equal(summary?.glyph, "✅");

    // 产物端点（内容可读，且有路径防护）
    const { artifacts } = (await (await fetch(`${base}/api/tasks/${taskId}/artifacts`)).json()) as {
      artifacts: Array<{ name: string; content: string }>;
    };
    assert.equal(artifacts.length, 2, "应有素材 + 初稿两份产物");
    assert.match(artifacts[0].content, /要点 1/);

    // 不存在的任务 → 404
    assert.equal((await fetch(`${base}/api/tasks/999`)).status, 404);

    // POST 缺参 → 400
    const bad = await fetch(`${base}/api/tasks`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 400);

    ws.close();
  } finally {
    await server.close();
  }
});

test("server：预算熔断任务在看板里如实显示 ⏸️ paused", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-server-pause-")), chart });
  const server = await createHiveServer({ kernel });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const post = await (await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "穷任务", brief: "预算不够也要如实说", budgetUsd: 0.1 }),
    })).json();
    const done = await waitUntil(async () => {
      const d = await (await fetch(`${base}/api/tasks/${post.taskId}`)).json();
      return d.status !== "running" ? d : null;
    }, 15000);
    assert.equal(done.status, "paused");
    assert.equal(done.glyph, "⏸️");
    assert.ok(done.timeline.some((t: { kind: string }) => t.kind === "budget.exceeded"));
  } finally {
    await server.close();
  }
});

test("CEO 门 API：pause/resume/instruct 端点，错误如实 400", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-server-ctrl-")), chart });
  const server = await createHiveServer({ kernel });
  try {
    const taskId = kernel.createTask({ title: "API 控制", brief: "端点验收", budgetUsd: 5 });
    const base = `http://127.0.0.1:${server.port}`;

    const pauseRes = await fetch(`${base}/api/tasks/${taskId}/pause`, {
      method: "POST",
      body: JSON.stringify({ by: "CEO" }),
    });
    assert.equal(pauseRes.status, 200);

    const runRes = await kernel.runTask(taskId); // 暂停标记生效 → 立即停在边界
    assert.equal(runRes.status, "paused");
    assert.equal(kernel.isPaused(taskId), true);

    const instructRes = await fetch(`${base}/api/tasks/${taskId}/instruct`, {
      method: "POST",
      body: JSON.stringify({ by: "CEO", botId: "writer", instruction: "直接写终稿" }),
    });
    assert.equal(instructRes.status, 200);

    const badRes = await fetch(`${base}/api/tasks/${taskId}/instruct`, {
      method: "POST",
      body: JSON.stringify({ botId: "ghost-bot", instruction: "x" }),
    });
    assert.equal(badRes.status, 400);
    const badBody = (await badRes.json()) as { error: string };
    assert.match(badBody.error, /无此 bot/);

    const resumeRes = await fetch(`${base}/api/tasks/${taskId}/resume`, {
      method: "POST",
      body: JSON.stringify({ by: "CEO" }),
    });
    assert.equal(resumeRes.status, 200);
    const resumeBody = (await resumeRes.json()) as { status: string };
    assert.equal(resumeBody.status, "ok");
    assert.equal(kernel.isPaused(taskId), false);
  } finally {
    await server.close();
  }
});

test("审批门 API：detail 暴露 pendingApproval，approve 放行，错误如实 400", async () => {
  const kernel = new HiveKernel({ dataDir: mkdtempSync(join(tmpdir(), "hive-server-appr-")), chart });
  const server = await createHiveServer({ kernel });
  try {
    process.env.HIVE_MOCK_APPROVAL = "send_external";
    const taskId = kernel.createTask({ title: "审批 API", brief: "端点验收", budgetUsd: 5 });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: "POST", body: JSON.stringify(body) });

    const runRes = await kernel.runTask(taskId); // reviewer 请求审批 → 挂起
    assert.equal(runRes.status, "paused");

    const detail = (await (await fetch(`${base}/api/tasks/${taskId}`)).json()) as { pendingApproval: string | null };
    assert.equal(detail.pendingApproval, "send_external");

    const bad = await post(`/api/tasks/${taskId}/approve`, { action: "other_thing" });
    assert.equal(bad.status, 400);

    const ok = await post(`/api/tasks/${taskId}/approve`, { action: "send_external", by: "CEO" });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { status: string };
    assert.equal(okBody.status, "ok");
    assert.equal(kernel.pendingApproval(taskId), null);
  } finally {
    delete process.env.HIVE_MOCK_APPROVAL;
    await server.close();
  }
});
