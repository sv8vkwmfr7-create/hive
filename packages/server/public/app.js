/* 蜂巢看板前端：vanilla JS，无构建步骤。
   数据真相源 = 内核事件流（HTTP 拉详情，WS 收实时事件）。 */
const state = {
  focusBot: null,
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
    case "approval.requested": return `🗂 请求审批：${p.action}（${p.risk}）`;
    case "approval.granted": return `✅ 批准：${p.action} by ${p.by}`;
    case "approval.denied": return `⛔ 拒绝：${p.action} by ${p.by}`;
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
    (d.paused ? ` · <b>⏸️ 已暂停</b>` : "") +
    (state.focusBot ? ` · <b>🎥 聚焦蜂房：${escapeHtml(state.focusBot)}</b> <button id="btn-unfocus" title="取消聚焦">✕</button>` : "");

  renderCeoControls(d);
  renderCanvas(d);
  bindUnfocus();

  const tl = $("#timeline");
  tl.innerHTML = "";
  const focusRows = state.focusBot ? d.timeline.filter((t) => t.actor === state.focusBot || t.kind === "task.created") : d.timeline;
  for (const t of focusRows) renderTimelineRow(t, tl);

  const out = $("#outputs");
  out.innerHTML = "";
  const outRows = d.timeline.filter((x) => x.kind === "bot.output" && (!state.focusBot || x.actor === state.focusBot));
  for (const t of outRows) {
    out.textContent += `[${t.actor}] ${t.payload.chunk}\n`;
  }
  out.scrollTop = out.scrollHeight;

  renderReceipt(d.receipt);
}

/* ---------- 蜂房聚焦（差异化①：点开任一蜂房看它的实时输出） ---------- */
function bindUnfocus() {
  const btn = $("#btn-unfocus");
  if (btn) btn.onclick = () => {
    state.focusBot = null;
    renderDetail();
  };
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
    (d.pendingApproval
      ? `<div style="margin-bottom:4px">🗂 <b>待批动作：${escapeHtml(d.pendingApproval)}</b>` +
        ` <button id="btn-approve">✅ 批准</button> <button id="btn-deny">⛔ 拒绝</button></div>`
      : "") +
    `<button id="btn-pause" title="停在下一次蜂房边界">⏸️ 暂停</button>` +
    `<button id="btn-resume">▶️ 恢复</button>` +
    ` <select id="takeover-bot">${roles}</select>` +
    `<input id="takeover-text" placeholder="✋ 接管：给选中的蜂房派指令" size="32"/>` +
    `<button id="btn-takeover">✋ 接管</button>` +
    ` <span id="ctrl-msg" class="dim"></span>`;
  if (d.pendingApproval) {
    $("#btn-approve").onclick = async () => {
      try {
        const r = await api(`/api/tasks/${d.taskId}/approve`, {
          method: "POST",
          body: JSON.stringify({ by: "board", action: d.pendingApproval }),
        });
        $("#ctrl-msg").textContent = `已批准 → ${r.status ?? ""}`;
      } catch (e) {
        $("#ctrl-msg").textContent = String(e.message ?? e);
      }
      void selectTask(d.taskId);
    };
    $("#btn-deny").onclick = async () => {
      const reason = window.prompt("拒绝理由（可选）：") ?? undefined;
      try {
        await api(`/api/tasks/${d.taskId}/deny`, {
          method: "POST",
          body: JSON.stringify({ by: "board", action: d.pendingApproval, reason }),
        });
        $("#ctrl-msg").textContent = "已拒绝，任务如实标失败";
      } catch (e) {
        $("#ctrl-msg").textContent = String(e.message ?? e);
      }
      void selectTask(d.taskId);
    };
  }
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

/* ---------- Mission Control 蜂房画布：RTS 式作战地图 ---------- */
function renderCanvas(d) {
  const el = $("#canvas");
  if (!el || !state.chart || !d) return;
  const roles = state.chart.roles ?? [];
  const handoffs = state.chart.handoffs ?? [];
  if (!roles.length) {
    el.textContent = "—";
    return;
  }

  // 分层：沿派单链 BFS（orchestrator 为根），层号 = 蜂房列
  const depth = {};
  for (const r of roles) if (r.kind === "orchestrator") depth[r.id] = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const h of handoffs) {
      if (depth[h.from] != null && (depth[h.to] == null || depth[h.to] < depth[h.from] + 1)) {
        depth[h.to] = depth[h.from] + 1;
        changed = true;
      }
    }
  }
  const cols = new Map();
  for (const r of roles) {
    const dep = depth[r.id] ?? 1;
    if (!cols.has(dep)) cols.set(dep, []);
    cols.get(dep).push(r);
  }
  const CW = 176,
    CH = 92,
    GX = 62,
    GY = 16;
  const colKeys = [...cols.keys()].sort((a, b) => a - b);
  const rowsMax = Math.max(...[...cols.values()].map((a) => a.length));
  const W = colKeys.length * (CW + GX) + 24;
  const H = rowsMax * (CH + GY) + 26;
  const pos = {};
  colKeys.forEach((dep, ci) => {
    const list = cols.get(dep);
    const offset = ((rowsMax - list.length) * (CH + GY)) / 2 + 13;
    list.forEach((r, i) => {
      pos[r.id] = { x: 12 + ci * (CW + GX), y: offset + i * (CH + GY) };
    });
  });

  // 每蜂状态：running / done / 出错；花费与产物按 actor 归集
  const botState = {};
  const spend = {};
  const arts = {};
  let verdict = null;
  let lastErrorBot = null;
  for (const t of d.timeline) {
    if (t.kind === "bot.spawned") botState[t.payload.botId] = "running";
    if (t.kind === "bot.exited" && t.payload.code === 0) botState[t.payload.botId] = "done";
    if (t.kind === "cost.recorded") spend[t.payload.botId] = (spend[t.payload.botId] ?? 0) + t.payload.usd;
    if (t.kind === "artifact.produced") arts[t.actor] = (arts[t.actor] ?? 0) + 1;
    if (t.kind === "review.verdict") verdict = t.payload;
    if (t.kind === "error.reported" && t.payload.byBot) lastErrorBot = t.payload.byBot;
  }
  const failed = d.status === "failed";

  const hex = (x, y, w, h) =>
    `${x + w * 0.22},${y} ${x + w * 0.78},${y} ${x + w},${y + h / 2} ${x + w * 0.78},${y + h} ${x + w * 0.22},${y + h} ${x},${y + h / 2}`;

  let cells = "";
  for (const r of roles) {
    const p = pos[r.id];
    const st = botState[r.id] ?? "idle";
    let fill = "#20242b",
      stroke = "#3a4150",
      glyph = "💤";
    if (st === "running") {
      fill = "#39301a";
      stroke = "#ffb454";
      glyph = "🔄";
    }
    if (st === "done") {
      fill = "#1e3326";
      stroke = "#4caf7d";
      glyph = "✅";
    }
    if (failed && lastErrorBot === r.id) {
      fill = "#3a1e1e";
      stroke = "#e5484d";
      glyph = "⛔";
    }
    const focused = state.focusBot === r.id;
    if (focused) stroke = "#4c9aff";
    const cls = ["cell", st === "running" ? "cell-running" : "", focused ? "cell-focus" : ""].filter(Boolean).join(" ");
    const vBadge = r.kind === "reviewer" && verdict ? ` · ${verdict.verdict === "PASS" ? "✅" : "⛔"}` : "";
    cells +=
      `<g class="${cls}" style="cursor:pointer" data-bot="${escapeHtml(r.id)}" title="点击聚焦该蜂房的实时输出">` +
      `<polygon points="${hex(p.x, p.y, CW, CH)}" fill="${fill}" stroke="${focused ? "#4c9aff" : stroke}" stroke-width="${focused ? 3 : 2}"/>` +
      `<text x="${p.x + 14}" y="${p.y + 24}" fill="#ffb454" font-size="15">🐝 ${escapeHtml(r.name)}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 44}" fill="#7d838e" font-size="11">${escapeHtml(r.engine?.adapter ?? "?")}${vBadge}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 62}" fill="#d7dae0" font-size="11">${glyph} $${(spend[r.id] ?? 0).toFixed(4)}${arts[r.id] ? ` · 📄×${arts[r.id]}` : ""}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 80}" fill="#7d838e" font-size="10">${escapeHtml(r.id)}</text>` +
      `</g>`;
  }

  // 派单链边：最近一次 handoff 高亮流动
  const lastHandoff = [...d.timeline].reverse().find((t) => t.kind === "handoff.created");
  let edges = "";
  for (const h of handoffs) {
    const a = pos[h.from];
    const b = pos[h.to];
    if (!a || !b) continue;
    const hot = lastHandoff && lastHandoff.payload.from === h.from && lastHandoff.payload.to === h.to;
    edges +=
      `<line x1="${a.x + CW}" y1="${a.y + CH / 2}" x2="${b.x}" y2="${b.y + CH / 2}"` +
      ` stroke="${hot ? "#ffb454" : "#3a4150"}" stroke-width="${hot ? 2.5 : 1.5}"` +
      ` marker-end="url(#${hot ? "arrow-hot" : "arrow"})">` +
      `<title>${escapeHtml(h.when ?? "")}</title></line>`;
  }

  const defs =
    `<defs>` +
    `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7d838e"/></marker>` +
    `<marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#ffb454"/></marker>` +
    `</defs>`;

  const verdictLine = verdict
    ? ` · 审核 <b>${verdict.verdict === "PASS" ? "✅ PASS" : verdict.verdict === "BLOCK" ? "⛔ BLOCK" : "⏸ HOLD"}</b>`
    : "";
  el.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="蜂房作战地图">${defs}${edges}${cells}</svg>` +
    `<div class="legend">点击蜂房 = 聚焦它的实时输出 · 🔄 执行中（脉冲）· ✅ 完成 · 💰 花费 · 📄 产物数 · 流动虚线 = 最近一次派单${verdictLine}</div>`;
  // 蜂房点击聚焦（再点同一蜂房取消）
  for (const g of el.querySelectorAll("g[data-bot]")) {
    g.addEventListener("click", () => {
      state.focusBot = state.focusBot === g.dataset.bot ? null : g.dataset.bot;
      renderDetail();
    });
  }
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
