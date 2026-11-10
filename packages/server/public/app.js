/* 蜂巢看板前端：vanilla JS，无构建步骤。
   数据真相源 = 内核事件流（HTTP 拉详情，WS 收实时事件）。 */
const state = {
  tasks: [],
  selected: null,
  detail: null,
  spend: 0,
  chart: null,
};

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

/* ---------- 事件 → 时间线行摘要 ---------- */
function briefOf(t) {
  const p = t.payload ?? {};
  switch (t.kind) {
    case "task.created": return `「${p.title}」预算 $${p.budgetUsd ?? "∞"}`;
    case "task.assigned": return `派单 → ${p.to}`;
    case "bot.spawned": return `🐝 ${p.botId}（${p.engine?.adapter ?? "?"}）`;
    case "bot.output": return p.chunk;
    case "handoff.created": return `${p.from} → ${p.to}（${p.note?.ask ?? ""}）`;
    case "artifact.produced": return `📄 ${String(p.path).split(/[\\/]/).at(-1)}`;
    case "cost.recorded": return `${p.botId} 花费 $${p.usd}`;
    case "review.verdict": return `${p.verdict}：${p.evidence ?? ""}`;
    case "task.status_changed": return p.reason ?? p.to;
    case "budget.exceeded": return `已花 $${p.usedUsd} 超预算 $${p.limitUsd}`;
    case "run.paused": return p.reason ?? "";
    case "run.resumed": return "▶️ 人工恢复";
    case "run.taken_over": return `✋ 接管 by ${p.by}`;
    case "bot.exited": return `${p.botId} 退出（code=${p.code})`;
    case "error.reported": return p.message;
    default: return "";
  }
}

function glyphOf(t) {
  if (t.glyph) return t.glyph;
  if (t.kind === "budget.exceeded" || t.kind === "run.paused") return "⏸️";
  if (t.kind === "error.reported") return "⛔";
  return "";
}

/* ---------- 渲染 ---------- */
function renderTasks() {
  const el = $("#tasks");
  el.innerHTML = "";
  for (const t of state.tasks) {
    const div = document.createElement("div");
    div.className = "task" + (String(t.taskId) === String(state.selected) ? " sel" : "");
    const budget = t.budgetUsd != null ? `/$${t.budgetUsd}` : "";
    div.innerHTML =
      `<span class="glyph">${t.glyph}</span><b>#${t.taskId}</b> ${escapeHtml(t.title)}` +
      ` <span class="dim">$${t.spendUsd.toFixed(2)}${budget}</span>`;
    div.onclick = () => void selectTask(t.taskId);
    el.appendChild(div);
  }
}

function renderTimelineRow(t, target) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML =
    `<span class="seq">${t.seq}</span><span class="glyph">${glyphOf(t)}</span>` +
    `<span class="kind">${t.kind}</span><span class="actor">${escapeHtml(t.actor)}</span>` +
    `<span class="brief" title="${escapeHtml(briefOf(t))}">${escapeHtml(briefOf(t))}</span>`;
  target.appendChild(row);
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  $("#status-line").innerHTML =
    `任务 #${d.taskId}「${escapeHtml(d.title)}」 ${d.glyph} ${d.status}` +
    ` · 已花费 <b>$${d.spendUsd.toFixed(2)}</b>${d.budgetUsd != null ? `/预算 $${d.budgetUsd}` : ""}` +
    (d.paused ? ` · <b>⏸️ 已暂停</b>` : "");

  renderCeoControls(d);

  const tl = $("#timeline");
  tl.innerHTML = "";
  for (const t of d.timeline) renderTimelineRow(t, tl);

  const out = $("#outputs");
  out.innerHTML = "";
  for (const t of d.timeline.filter((x) => x.kind === "bot.output")) {
    out.textContent += `[${t.actor}] ${t.payload.chunk}\n`;
  }
  out.scrollTop = out.scrollHeight;

  renderReceipt(d.receipt);
}

/* ---------- CEO 门：⏸️ 暂停 / ▶️ 恢复 / ✋ 接管派工 ---------- */
function renderCeoControls(d) {
  const ctrlId = "ceo-controls";
  let ctrl = document.getElementById(ctrlId);
  if (!ctrl) {
    ctrl = document.createElement("div");
    ctrl.id = ctrlId;
    ctrl.style.margin = "6px 0";
    $("#status-line").after(ctrl);
  }
  const roles = (state.chart?.roles ?? [])
    .map((r) => `<option value="${escapeHtml(r.id)}">🐝 ${escapeHtml(r.name || r.id)}</option>`)
    .join("");
  ctrl.innerHTML =
    `<button id="btn-pause" title="停在下一次蜂房边界">⏸️ 暂停</button>` +
    `<button id="btn-resume">▶️ 恢复</button>` +
    ` <select id="takeover-bot">${roles}</select>` +
    `<input id="takeover-text" placeholder="✋ 接管：给选中的蜂房派指令" size="32"/>` +
    `<button id="btn-takeover">✋ 接管</button>` +
    ` <span id="ctrl-msg" class="dim"></span>`;
  $("#btn-pause").onclick = async () => {
    try {
      await api(`/api/tasks/${d.taskId}/pause`, { method: "POST", body: JSON.stringify({ by: "board" }) });
      $("#ctrl-msg").textContent = "已暂停（运行中的蜂跑完本回合后停）";
    } catch (e) {
      $("#ctrl-msg").textContent = String(e.message ?? e);
    }
    void selectTask(d.taskId);
  };
  $("#btn-resume").onclick = async () => {
    $("#ctrl-msg").textContent = "恢复中…";
    try {
      const r = await api(`/api/tasks/${d.taskId}/resume`, { method: "POST", body: JSON.stringify({ by: "board" }) });
      $("#ctrl-msg").textContent = `已恢复 → ${r.status}${r.reason ? `（${r.reason}）` : ""}`;
    } catch (e) {
      $("#ctrl-msg").textContent = String(e.message ?? e);
    }
    void selectTask(d.taskId);
  };
  $("#btn-takeover").onclick = async () => {
    const botId = $("#takeover-bot").value;
    const instruction = $("#takeover-text").value;
    try {
      await api(`/api/tasks/${d.taskId}/instruct`, {
        method: "POST",
        body: JSON.stringify({ by: "board", botId, instruction }),
      });
      $("#ctrl-msg").textContent = `已派给 ${botId}（恢复后第一个执行）`;
      $("#takeover-text").value = "";
    } catch (e) {
      $("#ctrl-msg").textContent = String(e.message ?? e);
    }
    void selectTask(d.taskId);
  };
}

function renderReceipt(receipt) {
  const el = $("#receipt");
  if (!receipt || receipt.entries.length === 0) {
    el.innerHTML = '<span class="dim">—</span>';
    return;
  }
  const rows = receipt.entries
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.botId)}</td><td>${escapeHtml(e.engine)}</td>` +
        `<td>${e.tokensIn ?? "-"}</td><td>${e.tokensOut ?? "-"}</td><td>$${e.usd}</td></tr>`,
    )
    .join("");
  el.innerHTML =
    `<table><tr><th>bot</th><th>引擎</th><th>tokensIn</th><th>tokensOut</th><th>花费</th></tr>${rows}` +
    `<tr class="total"><td colspan="4">合计</td><td>$${receipt.totalUsd.toFixed(2)}</td></tr></table>` +
    `<div class="dim">小票已落盘：data/ledger/task-${receipt.taskId}.receipt.json</div>`;
}

async function renderArtifacts() {
  const el = $("#artifacts");
  if (!state.selected) return;
  const { artifacts } = await api(`/api/tasks/${state.selected}/artifacts`);
  if (artifacts.length === 0) {
    el.innerHTML = '<span class="dim">—</span>';
    return;
  }
  el.innerHTML = "";
  for (const a of artifacts) {
    const det = document.createElement("details");
    det.innerHTML = `<summary>📄 ${escapeHtml(a.name)}</summary><pre>${escapeHtml(a.content)}</pre>`;
    el.appendChild(det);
  }
}

/* ---------- 数据流 ---------- */
async function refreshTasks() {
  const { tasks } = await api("/api/tasks");
  state.tasks = tasks;
  renderTasks();
  if (!state.selected && tasks.length) void selectTask(tasks[0].taskId);
}

async function selectTask(taskId) {
  state.selected = String(taskId);
  state.detail = await api(`/api/tasks/${taskId}`);
  renderDetail();
  await renderArtifacts();
  renderTasks();
}

let refreshTimer = null;
function scheduleTaskRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshTasks().then(() => {
      if (state.selected && state.tasks.some((t) => String(t.taskId) === String(state.selected))) {
        void api(`/api/tasks/${state.selected}`).then((d) => {
          state.detail = d;
          renderDetail();
        });
      }
    });
  }, 400);
}

function onWsEvent(event) {
  if (String(event.taskId) === String(state.selected)) {
    const tl = $("#timeline");
    if (tl.classList.contains("dim")) tl.classList.remove("dim");
    renderTimelineRow(event, tl);
    if (event.kind === "bot.output") {
      const out = $("#outputs");
      out.classList.remove("dim");
      out.textContent += `[${event.actor}] ${event.payload.chunk}\n`;
      out.scrollTop = out.scrollHeight;
    }
    if (event.kind === "cost.recorded") scheduleTaskRefresh();
    if (event.kind === "task.status_changed") {
      scheduleTaskRefresh();
      void renderArtifacts();
    }
  } else {
    scheduleTaskRefresh();
  }
}

/* ---------- 启动 ---------- */
const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
ws.onopen = () => { $("#conn").textContent = "● 实时"; };
ws.onclose = () => { $("#conn").textContent = "● 断线（刷新重连）"; };
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.type === "snapshot") {
    state.tasks = msg.tasks;
    renderTasks();
    if (!state.selected && msg.tasks.length) void selectTask(msg.tasks[0].taskId);
  } else if (msg.type === "event") {
    onWsEvent(msg.event);
  }
};

fetch("/api/chart").then((r) => r.json()).then(({ chart }) => {
  state.chart = chart;
  $("#team").textContent = `团队：${chart.team}（${chart.roles.length} 蜂房）`;
});

$("#new-task").onsubmit = async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const r = await api("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: f.get("title"),
      brief: f.get("brief"),
      budgetUsd: Number(f.get("budget")) || 3,
      source: "web-board",
    }),
  });
  ev.target.reset();
  await refreshTasks();
  void selectTask(r.taskId);
};

void refreshTasks();
