/* 蜂巢审批 PWA 前端：一屏一单，批准 / 拒绝 / 恢复，数据与看板同源（同内核 API） */
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const api = async (p, opts) => {
  const r = await fetch(p, opts);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

function card(t) {
  const spend = `已花 $${t.spendUsd.toFixed(2)}${t.budgetUsd != null ? ` / 预算 $${t.budgetUsd}` : ""}`;
  let actions = "";
  if (t.pendingApproval) {
    actions =
      `<div class="pending">🗂 待批：${esc(t.pendingApproval)}</div>` +
      `<div class="row">` +
      `<button class="big ok" data-act="approve" data-task="${t.taskId}" data-action="${esc(t.pendingApproval)}">✅ 批准</button>` +
      `<button class="big no" data-act="deny" data-task="${t.taskId}" data-action="${esc(t.pendingApproval)}">⛔ 拒绝</button>` +
      `</div><div class="msg" id="msg-${t.taskId}"></div>`;
  } else if (t.paused) {
    actions =
      `<div class="row"><button class="big" data-act="resume" data-task="${t.taskId}">▶️ 恢复执行</button></div>` +
      `<div class="msg" id="msg-${t.taskId}"></div>`;
  }
  return (
    `<section class="card${t.pendingApproval ? " card-pending" : ""}">` +
    `<div class="card-title">${t.glyph ?? ""} #${t.taskId} ${esc(t.title)}</div>` +
    `<div class="dim">${spend} · ${esc(t.status)}${t.paused && !t.pendingApproval ? " · ⏸️ 暂停" : ""}</div>` +
    actions +
    `</section>`
  );
}

function render(tasks) {
  const el = $("#cards");
  if (!tasks.length) {
    el.innerHTML = '<div class="pad dim">还没有任务——去桌面看板发一单。</div>';
    return;
  }
  const pending = tasks.filter((t) => t.pendingApproval);
  const paused = tasks.filter((t) => !t.pendingApproval && t.paused);
  const rest = tasks.filter((t) => !t.pendingApproval && !t.paused);
  const ordered = [...pending, ...paused, ...rest];
  el.innerHTML = ordered.map(card).join("");
}

let busy = false; // 交互期间暂停轮询：轮询重渲染会换掉按钮节点，打断点击
async function refresh() {
  if (busy) return;
  try {
    const { tasks } = await api("/api/tasks");
    render(tasks);
    $("#conn").textContent = "● 实时";
  } catch (e) {
    $("#conn").textContent = "● 离线（自动重试）";
  }
}

$("#cards").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const { act, task, action } = btn.dataset;
  const msg = $(`#msg-${task}`);
  const setMsg = (s) => {
    if (msg) msg.textContent = s;
  };
  btn.disabled = true;
  busy = true;
  try {
    if (act === "approve") {
      setMsg("批准中…");
      const r = await api(`/api/tasks/${task}/approve`, {
        method: "POST",
        body: JSON.stringify({ by: "mobile", action }),
      });
      setMsg(`✅ 已批准 → ${r.status ?? ""}`);
    } else if (act === "deny") {
      setMsg("拒绝中…");
      await api(`/api/tasks/${task}/deny`, {
        method: "POST",
        body: JSON.stringify({ by: "mobile", action, reason: "手机审批拒绝" }),
      });
      setMsg("⛔ 已拒绝，任务如实标失败");
    } else if (act === "resume") {
      setMsg("恢复中…");
      const r = await api(`/api/tasks/${task}/resume`, {
        method: "POST",
        body: JSON.stringify({ by: "mobile" }),
      });
      setMsg(`▶️ ${r.status === "ok" ? "已交付" : r.status === "paused" ? "仍暂停" : r.status}`);
    }
  } catch (e) {
    setMsg(String(e.message ?? e).slice(0, 160));
  }
  btn.disabled = false;
  busy = false;
  setTimeout(refresh, 600);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

void refresh();
setInterval(refresh, 4000);
