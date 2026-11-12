/* 蜂巢组织编辑器前端：vanilla JS，无构建步骤。
   数据真相源 = teams/*.json（GET/PUT /api/org/*）。
   拖拽位置仅存在于当前会话（图 JSON 保持平台无关，不落坐标）；保存前必过内核校验。 */
const state = {
  templates: [],
  name: null,
  chart: null,
  pos: {}, // sessionId 内的画布坐标，不持久化
  sel: null, // 选中的角色 id
  dirty: false,
};

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let body = await r.text();
    try {
      body = JSON.stringify(JSON.parse(body));
    } catch {
      /* 原样展示 */
    }
    throw new Error(`${r.status} ${body}`);
  }
  return r.json();
}

function markDirty() {
  state.dirty = true;
  $("#btn-save").disabled = false;
  $("#editor-status").textContent = "● 有未保存修改";
}

const ADAPTERS = ["deepseek", "qwen", "moonshot", "openrouter", "doubao", "zhipu", "siliconflow", "groq", "kaitian", "ollama", "mock"];
const APPROVAL_ACTIONS = ["send_external", "spend", "merge", "deploy"];

/* ---------- 模板列表 ---------- */
async function loadTemplates() {
  const { templates } = await api("/api/org/templates");
  state.templates = templates;
  renderTemplates();
}

function renderTemplates() {
  const el = $("#tpl-items");
  el.className = "";
  el.innerHTML = "";
  for (const t of state.templates) {
    const div = document.createElement("div");
    div.className = "tpl" + (t.file === state.name ? " sel" : "");
    div.innerHTML =
      `<span class="${t.valid ? "ok" : "bad"}">${t.valid ? "✅" : "⛔"}</span> <b>${escapeHtml(t.file)}</b>` +
      ` <span class="dim">${t.roles}蜂·${t.handoffs}边</span>`;
    div.onclick = () => void openTemplate(t.file);
    el.appendChild(div);
  }
}

async function openTemplate(name) {
  if (state.dirty && !confirm("有未保存修改，放弃并切换模板？")) return;
  const { chart, errors } = await api(`/api/org/template/${encodeURIComponent(name)}`);
  state.name = name;
  state.chart = chart;
  state.sel = null;
  state.dirty = false;
  $("#btn-save").disabled = true;
  $("#btn-add-role").disabled = false;
  $("#cur-name").textContent = name;
  layout();
  renderAll();
  $("#save-msg").textContent = errors?.length ? `⚠️ 当前图有校验问题：${errors.join("；")}` : "";
}

/* ---------- 布局：沿派单链 BFS 分层（与看板作战地图同款） ---------- */
function layout() {
  const roles = state.chart?.roles ?? [];
  const handoffs = state.chart?.handoffs ?? [];
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
  const CW = 176, CH = 92, GX = 62, GY = 16;
  const colKeys = [...cols.keys()].sort((a, b) => a - b);
  const rowsMax = Math.max(1, ...[...cols.values()].map((a) => a.length));
  const pos = {};
  colKeys.forEach((dep, ci) => {
    const list = cols.get(dep);
    const offset = ((rowsMax - list.length) * (CH + GY)) / 2 + 13;
    list.forEach((r, i) => {
      pos[r.id] = { x: 12 + ci * (CW + GX), y: offset + i * (CH + GY) };
    });
  });
  state.pos = pos;
  state.grid = { CW, CH, GX, GY, W: colKeys.length * (CW + GX) + 24, H: rowsMax * (CH + GY) + 26 };
}

/* ---------- 画布：六边形蜂房 + 派单边，可拖拽 ---------- */
const hex = (x, y, w, h) =>
  `${x + w * 0.22},${y} ${x + w * 0.78},${y} ${x + w},${y + h / 2} ${x + w * 0.78},${y + h} ${x + w * 0.22},${y + h} ${x},${y + h / 2}`;

const KIND_GLYPH = { orchestrator: "👑", specialist: "🔧", reviewer: "🔍" };

function renderCanvas() {
  const el = $("#org-canvas");
  const chart = state.chart;
  if (!chart) return;
  el.className = "";
  const roles = chart.roles ?? [];
  const handoffs = chart.handoffs ?? [];
  const { CW, CH, W, H } = state.grid;

  let edges = "";
  for (const h of handoffs) {
    const a = state.pos[h.from];
    const b = state.pos[h.to];
    if (!a || !b) continue;
    edges +=
      `<line x1="${a.x + CW}" y1="${a.y + CH / 2}" x2="${b.x}" y2="${b.y + CH / 2}"` +
      ` stroke="#3a4150" stroke-width="1.5" marker-end="url(#arrow)">` +
      `<title>${escapeHtml(h.when ?? "")}</title></line>`;
  }

  let cells = "";
  for (const r of roles) {
    const p = state.pos[r.id];
    const selCls = state.sel === r.id ? " sel" : "";
    cells +=
      `<g class="cell${selCls}" data-id="${escapeHtml(r.id)}">` +
      `<polygon points="${hex(p.x, p.y, CW, CH)}" fill="#20242b" stroke="#3a4150" stroke-width="2"/>` +
      `<text x="${p.x + 14}" y="${p.y + 24}" fill="#ffb454" font-size="15">${KIND_GLYPH[r.kind] ?? "🐝"} ${escapeHtml(r.name)}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 44}" fill="#7d838e" font-size="11">${escapeHtml(r.engine?.adapter ?? "?")}${r.engine?.model ? ` · ${escapeHtml(r.engine.model)}` : ""}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 62}" fill="#d7dae0" font-size="11">${escapeHtml(r.kind)}</text>` +
      `<text x="${p.x + 14}" y="${p.y + 80}" fill="#7d838e" font-size="10">${escapeHtml(r.id)}${r.guards?.needs_approval_for?.length ? ` · 🗂${r.guards.needs_approval_for.join("/")}` : ""}</text>` +
      `</g>`;
  }

  const defs =
    `<defs>` +
    `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7d838e"/></marker>` +
    `</defs>`;

  el.innerHTML =
    `<svg id="org-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="组织架构画布">${defs}${edges}${cells}</svg>` +
    `<div class="legend">拖拽移动蜂房 · 点击蜂房编辑属性 · ＋加蜂房派单 · 💾保存过内核校验（坐标不入图 JSON）</div>`;

  bindDrag();
}

function svgPoint(e) {
  const svg = $("#org-svg");
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return { x: ((e.clientX - rect.left) * vb.width) / rect.width, y: ((e.clientY - rect.top) * vb.height) / rect.height };
}

function bindDrag() {
  const el = $("#org-canvas");
  let drag = null;
  el.onmousedown = (e) => {
    const g = e.target.closest?.(".cell");
    if (!g) return;
    const p = svgPoint(e);
    const id = g.dataset.id;
    drag = { id, dx: state.pos[id].x - p.x, dy: state.pos[id].y - p.y, moved: false };
    e.preventDefault();
  };
  el.onmousemove = (e) => {
    if (!drag) return;
    const p = svgPoint(e);
    const pos = state.pos[drag.id];
    const nx = Math.max(0, p.x + drag.dx);
    const ny = Math.max(0, p.y + drag.dy);
    if (Math.abs(nx - pos.x) > 2 || Math.abs(ny - pos.y) > 2) drag.moved = true;
    pos.x = nx;
    pos.y = ny;
    renderCanvas();
  };
  el.onmouseup = () => {
    if (drag && !drag.moved) selectRole(drag.id);
    drag = null;
  };
}

/* ---------- 角色表单：只改已知字段，passthrough 的社区字段原样保留 ---------- */
function selectRole(id) {
  state.sel = id;
  renderCanvas();
  renderRoleForm();
}

function renderRoleForm() {
  const el = $("#role-form");
  const r = state.chart?.roles?.find((x) => x.id === state.sel);
  if (!r) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  r.engine ??= { type: "cli", adapter: "mock" };
  r.guards ??= {};
  const g = r.guards;
  const isReviewer = r.kind === "reviewer";
  el.innerHTML =
    `<b>🐝 编辑蜂房</b> <button id="btn-del-role">🗑 删除蜂房</button>` +
    `<div class="row"><label>id</label><input id="f-id" value="${escapeHtml(r.id)}" /></div>` +
    `<div class="row"><label>名称</label><input id="f-name" value="${escapeHtml(r.name)}" /></div>` +
    `<div class="row"><label>角色类型</label><select id="f-kind">` +
    ["orchestrator", "specialist", "reviewer"].map((k) => `<option value="${k}"${r.kind === k ? " selected" : ""}>${k}</option>`).join("") +
    `</select></div>` +
    `<div class="row"><label>引擎类型</label><select id="f-etype">` +
    ["cli", "api", "local"].map((k) => `<option value="${k}"${r.engine.type === k ? " selected" : ""}>${k}</option>`).join("") +
    `</select> <label>adapter</label><input id="f-adapter" list="adapter-list" value="${escapeHtml(r.engine.adapter)}" />` +
    `<datalist id="adapter-list">${ADAPTERS.map((a) => `<option value="${a}">`).join("")}</datalist>` +
    ` <label>model</label><input id="f-model" value="${escapeHtml(r.engine.model ?? "")}" placeholder="留空 = 契约默认" /></div>` +
    `<div class="row"><label>profile</label><input id="f-profile" value="${escapeHtml(r.profile)}" /></div>` +
    `<div class="row"><label>可发起 @</label><input id="f-mention" type="checkbox"${g.can_initiate_mention ? " checked" : ""} />` +
    ` <label>日预算 $</label><input id="f-budget" type="number" min="0.1" step="0.1" value="${g.daily_budget_usd ?? ""}" />` +
    ` <label>max_turns</label><input id="f-turns" type="number" min="1" value="${g.max_turns ?? ""}" /></div>` +
    `<div class="row"><label>审批门动作</label>` +
    APPROVAL_ACTIONS.map((a) => `<label style="min-width:auto"><input type="checkbox" class="f-appr" value="${a}"${g.needs_approval_for?.includes(a) ? " checked" : ""} /> ${a}</label>`).join(" ") +
    `</div>`;

  $("#f-id").onchange = (e) => {
    const nid = e.target.value.trim();
    if (!nid || nid === r.id) return;
    if (state.chart.roles.some((x) => x.id === nid)) {
      alert(`id「${nid}」已存在`);
      e.target.value = r.id;
      return;
    }
    for (const h of state.chart.handoffs ?? []) {
      if (h.from === r.id) h.from = nid;
      if (h.to === r.id) h.to = nid;
    }
    r.id = nid;
    state.sel = nid;
    markDirty();
    renderAll();
  };
  $("#f-name").onchange = (e) => {
    r.name = e.target.value.trim() || r.name;
    markDirty();
    renderCanvas();
  };
  $("#f-kind").onchange = (e) => {
    r.kind = e.target.value;
    if (r.kind === "reviewer") {
      // 内核语义：审核员不得主动发起 @——切到 reviewer 就地关掉，别等保存报错
      g.can_initiate_mention = false;
      $("#f-mention").checked = false;
    }
    markDirty();
    renderAll();
  };
  $("#f-etype").onchange = (e) => {
    r.engine.type = e.target.value;
    markDirty();
  };
  $("#f-adapter").onchange = (e) => {
    r.engine.adapter = e.target.value.trim() || "mock";
    markDirty();
    renderCanvas();
  };
  $("#f-model").onchange = (e) => {
    const v = e.target.value.trim();
    if (v) r.engine.model = v;
    else delete r.engine.model;
    markDirty();
    renderCanvas();
  };
  $("#f-profile").onchange = (e) => {
    r.profile = e.target.value.trim() || r.profile;
    markDirty();
  };
  $("#f-mention").onchange = (e) => {
    g.can_initiate_mention = e.target.checked;
    markDirty();
  };
  $("#f-budget").onchange = (e) => {
    const v = Number(e.target.value);
    if (v > 0) g.daily_budget_usd = v;
    else delete g.daily_budget_usd;
    markDirty();
  };
  $("#f-turns").onchange = (e) => {
    const v = Number(e.target.value);
    if (v > 0) g.max_turns = v;
    else delete g.max_turns;
    markDirty();
  };
  for (const box of el.querySelectorAll(".f-appr")) {
    box.onchange = () => {
      const picked = [...el.querySelectorAll(".f-appr:checked")].map((b) => b.value);
      if (picked.length) g.needs_approval_for = picked;
      else delete g.needs_approval_for;
      markDirty();
      renderCanvas();
    };
  }
  $("#btn-del-role").onclick = () => {
    const orchestrators = state.chart.roles.filter((x) => x.kind === "orchestrator");
    if (r.kind === "orchestrator" && orchestrators.length <= 1) {
      alert("总管必须恰好 1 个——先加另一只总管蜂再删这只（内核语义校验）");
      return;
    }
    if (!confirm(`删除蜂房「${r.name}」（${r.id}）及其相关派单边？`)) return;
    state.chart.roles = state.chart.roles.filter((x) => x.id !== r.id);
    state.chart.handoffs = (state.chart.handoffs ?? []).filter((h) => h.from !== r.id && h.to !== r.id);
    state.sel = null;
    markDirty();
    layout();
    renderAll();
  };
}

/* ---------- 派单面板 ---------- */
function renderHandoffs() {
  const el = $("#handoffs-pane");
  if (!state.chart) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const rows = (state.chart.handoffs ?? [])
    .map(
      (h, i) =>
        `<tr><td>${escapeHtml(h.from)}</td><td>${escapeHtml(h.to)}</td><td>${escapeHtml(h.when ?? "")}</td>` +
        `<td><button data-i="${i}" class="del-handoff">🗑</button></td></tr>`,
    )
    .join("");
  const opts = (sel) => (state.chart.roles ?? []).map((r) => `<option value="${escapeHtml(r.id)}"${r.id === sel ? " selected" : ""}>${escapeHtml(r.name || r.id)}</option>`).join("");
  el.innerHTML =
    `<b>📋 派单链（${state.chart.handoffs?.length ?? 0} 条边）</b>` +
    `<table><tr><th>from</th><th>to</th><th>when</th><th></th></tr>${rows}</table>` +
    `<div class="row" style="margin-top:6px">＋ <select id="h-from">${opts()}</select> → <select id="h-to">${opts()}</select>` +
    ` <input id="h-when" placeholder="何时派单，如：素材齐备" size="26" /> <button id="btn-add-handoff">加派单边</button></div>`;
  for (const btn of el.querySelectorAll(".del-handoff")) {
    btn.onclick = () => {
      state.chart.handoffs.splice(Number(btn.dataset.i), 1);
      markDirty();
      layout();
      renderAll();
    };
  }
  $("#btn-add-handoff").onclick = () => {
    const from = $("#h-from").value;
    const to = $("#h-to").value;
    const when = $("#h-when").value.trim() || "任务分派";
    if (from === to) {
      alert("派单边不能自环（内核语义校验会拒绝）");
      return;
    }
    state.chart.handoffs ??= [];
    if (state.chart.handoffs.some((h) => h.from === from && h.to === to)) {
      alert("这两个蜂房之间已有派单边");
      return;
    }
    state.chart.handoffs.push({ from, to, when });
    markDirty();
    layout();
    renderAll();
  };
}

function renderAll() {
  renderCanvas();
  renderHandoffs();
  renderRoleForm();
  renderTemplates();
}

/* ---------- 保存 / 新建 ---------- */
async function saveChart() {
  const msg = $("#save-msg");
  msg.textContent = "保存中…";
  try {
    await api(`/api/org/template/${encodeURIComponent(state.name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chart: state.chart }),
    });
    state.dirty = false;
    $("#btn-save").disabled = true;
    msg.textContent = `✅ 已保存 ${state.name}.json（内核校验通过）`;
    $("#editor-status").textContent = "组织即配置：拖拽蜂房 · 表单改属性 · 保存即校验";
    await loadTemplates();
  } catch (e) {
    // 诚实回显：schema/语义校验失败原样列出，一个字不粉饰
    let text = String(e.message ?? e);
    try {
      const doc = JSON.parse(text.replace(/^\d+\s/, ""));
      if (doc.issues?.length) text = `${doc.error}：\n` + doc.issues.map((i) => `· ${typeof i === "string" ? i : `${i.path?.join?.(".") ?? ""} ${i.message ?? ""}`}`).join("\n");
    } catch {
      /* 保留原始错误 */
    }
    msg.textContent = "";
    msg.innerHTML = `⛔ 保存失败：${escapeHtml(text)}`;
  }
}

function blankChart(name) {
  return {
    schema_version: 1,
    team: name,
    roles: [
      { id: "chief", name: "总管", kind: "orchestrator", engine: { type: "cli", adapter: "mock" }, profile: "profiles/总管.md", guards: { can_initiate_mention: true } },
      { id: "worker", name: "新蜂房", kind: "specialist", engine: { type: "cli", adapter: "mock" }, profile: "profiles/新蜂房.md", guards: { can_initiate_mention: false } },
    ],
    handoffs: [{ from: "chief", to: "worker", when: "任务分派" }],
  };
}

async function newTeam() {
  const name = window.prompt("新团队名（字母/数字/-/_，保存到 teams/<名>.json）：");
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return;
  try {
    await api(`/api/org/template/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chart: blankChart(name) }),
    });
    await loadTemplates();
    await openTemplate(name);
    $("#save-msg").textContent = `✅ 已创建 ${name}.json（mock 引擎起家，随时换脑）`;
  } catch (e) {
    $("#save-msg").textContent = `⛔ 创建失败：${String(e.message ?? e).slice(0, 200)}`;
  }
}

/* ---------- 启动 ---------- */
$("#btn-save").onclick = () => void saveChart();
$("#btn-add-role").onclick = () => {
  if (!state.chart) return;
  let n = 1;
  while (state.chart.roles.some((r) => r.id === `new-bot-${n}`)) n++;
  const role = {
    id: `new-bot-${n}`,
    name: "新蜂房",
    kind: "specialist",
    engine: { type: "cli", adapter: "mock" },
    profile: "profiles/新蜂房.md",
    guards: { can_initiate_mention: false },
  };
  state.chart.roles.push(role);
  // 挂到总管的派单链上，避免孤蜂（总管出边是合法默认）
  const chief = state.chart.roles.find((r) => r.kind === "orchestrator");
  if (chief) {
    state.chart.handoffs ??= [];
    state.chart.handoffs.push({ from: chief.id, to: role.id, when: "任务分派" });
  }
  state.sel = role.id;
  markDirty();
  layout();
  renderAll();
};
$("#btn-new").onclick = () => void newTeam();
window.onbeforeunload = (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
};

void loadTemplates();
