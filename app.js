const $ = (selector) => document.querySelector(selector);
const form = $("#create");
const taskStates = {
  planning: "拆解中", executing: "并行执行", integrating: "合并预览", summarizing: "汇总中",
  queued: "排队", running: "执行中", waiting: "待回填", done: "完成",
  partial: "部分完成", failed: "失败", skipped: "已跳过", cancelled: "已停止",
  applied: "已合入预览", conflict: "补丁冲突",
};
const phases = ["planning", "executing", "integrating", "summarizing"];
const connectionLabels = {
  cli: "检测到 CLI", missing: "需配置 CLI", api: "已配置 API",
  webhook: "已配置 Webhook", manual: "手动交接",
};
let catalog = [];
let token;
let selectedJob;
let activeJob;
let shownJob;
let signature;
let inventoryKey;
let historyKey;
let requestInProgress = false;
let submitting = false;
const manualDrafts = new Map();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json", "X-Center-Token": token || "" },
    body: JSON.stringify(body),
  };
  const response = await fetch(path, options);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "请求失败。");
  return json;
}

function showError(error) {
  $("#form-error").textContent = error || "";
  $("#form-error").hidden = !error;
}

function syncForm() {
  const demo = form.elements.mode.value === "demo";
  const lead = catalog.find(({ id }) => id === "claude");
  $("#repo-field").hidden = demo;
  $("#mode-note").textContent = demo
    ? "模拟整个协作流程，无需账号或 API 密钥。"
    : lead?.mode === "missing"
      ? "真实运行需要安装并登录 Claude Code CLI。"
      : "使用已配置的 Agent 账号。远程 Agent 根据项目说明交付文本。";
  form.querySelectorAll("input[name=agent]").forEach((input) => {
    input.disabled = !demo && input.dataset.mode === "missing";
  });
  $("#start").innerHTML = demo ? "<span aria-hidden='true'>▶</span> 运行演示" : "<span aria-hidden='true'>▶</span> 启动项目";
  $("#start").disabled = !token || submitting || Boolean(activeJob) || (!demo && lead?.mode !== "cli");
}

function renderInventory(agents) {
  const key = JSON.stringify(agents);
  if (key === inventoryKey) return;
  inventoryKey = key;
  catalog = agents;
  const checks = new Map([...form.querySelectorAll("input[name=agent]")].map((input) => [input.value, input.checked]));
  $("#roster").innerHTML = agents.map((agent) => `
    <li class="agent ${agent.id === "claude" ? "lead" : ""}">
      <span class="avatar" aria-hidden="true">${escapeHtml(agent.initial)}</span>
      <div class="agent-copy"><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.role)}</small></div>
      <span class="dot ${agent.mode}" title="${connectionLabels[agent.mode]}" aria-label="${connectionLabels[agent.mode]}"></span>
    </li>`).join("");
  $("#workers").innerHTML = agents.filter(({ id }) => id !== "claude").map((agent) => `
    <label class="worker" title="${connectionLabels[agent.mode]}">
      <input type="checkbox" name="agent" value="${agent.id}" data-mode="${agent.mode}" ${checks.get(agent.id) !== false ? "checked" : ""}>
      ${escapeHtml(agent.name)}
    </label>`).join("");
}

function renderHistory(jobs) {
  const key = JSON.stringify([jobs, selectedJob]);
  if (key === historyKey) return;
  historyKey = key;
  $("#history").innerHTML = jobs.length ? jobs.map((job) => `
    <li><button type="button" data-job="${job.id}" aria-current="${job.id === selectedJob}">
      <span>${escapeHtml(job.title)}</span><small>${taskStates[job.status]}</small>
    </button></li>`).join("") : '<li class="muted">暂无运行记录</li>';
}

function badge(status) {
  return `<span class="badge ${status}">${taskStates[status] || status}</span>`;
}

function fileLink(job, filename, label) {
  return `<a class="subtle" href="/api/jobs/${job}/${filename}">${label}</a>`;
}

function renderTask(job, task, open) {
  const { name, initial } = catalog.find(({ id }) => id === task.agent);
  const waiting = task.status === "waiting";
  const draft = manualDrafts.get(`${job.id}/${task.agent}`);
  const manual = waiting ? `
    <div class="manual">
      <p>${task.dispatched ? "已触发 Grok Bot。完成后，将 Bot 对话里的结果粘贴到这里。" : "复制任务到对应 Agent。完成后，将结果粘贴到这里。"}</p>
      <label class="sr-only" for="reply-${task.agent}">${name} 结果</label>
      <textarea id="reply-${task.agent}" rows="3" maxlength="24000" data-reply="${task.agent}" placeholder="粘贴 Agent 的交付结果">${escapeHtml(draft)}</textarea>
      <div class="actions">
        <button type="button" class="subtle" data-copy="${task.agent}">复制任务</button>
        <button type="button" class="subtle accent" data-submit="${task.agent}">提交结果</button>
        <button type="button" class="subtle" data-skip="${task.agent}">跳过</button>
      </div>
    </div>` : "";
  const actions = [
    task.patch && fileLink(job.id, task.patch, "下载补丁"),
    job.mode === "live" && task.workspace && fileLink(job.id, `${task.agent}.log`, "下载日志"),
  ].filter(Boolean).join("");
  return `
    <details class="task" data-task="${task.agent}" ${open || waiting ? "open" : ""}>
      <summary>
        <span class="avatar" aria-hidden="true">${initial}</span>
        <span class="task-name"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(name)}</small></span>
        ${task.merge ? badge(task.merge) : ""}
        ${badge(task.status)}
      </summary>
      <div class="task-body">
        <p>${escapeHtml(task.instruction)}</p>
        ${task.output ? `<p>${escapeHtml(task.output)}</p>` : ""}
        ${task.error ? `<p class="error">${escapeHtml(task.error)}</p>` : ""}
        ${task.merge_error ? `<p class="error">${escapeHtml(task.merge_error)}</p>` : ""}
        ${actions ? `<div class="actions">${actions}</div>` : ""}
        ${manual}
      </div>
    </details>`;
}

function renderRun(job) {
  const nextSignature = JSON.stringify(job);
  if (signature === nextSignature) return;
  signature = nextSignature;
  const sameJob = shownJob?.id === job.id;
  shownJob = job;
  const root = $("#run-content");
  const focused = document.activeElement?.dataset.reply;
  const oldDraft = focused && document.activeElement;
  const selection = oldDraft ? [oldDraft.selectionStart, oldDraft.selectionEnd] : null;
  const open = new Set(sameJob ? [...root.querySelectorAll("details[open]")].map((node) => node.dataset.task) : []);
  const stage = phases.indexOf(job.status);
  const completed = ["done", "partial"].includes(job.status);
  document.querySelectorAll("[data-phase]").forEach((node, index) => {
    node.classList.toggle("active", index === stage);
    node.classList.toggle("complete", completed || (stage >= 0 && index < stage));
  });
  const status = $("#job-badge");
  status.hidden = false;
  status.className = `badge ${stage >= 0 ? "running" : job.status}`;
  status.textContent = taskStates[job.status];
  root.innerHTML = `
    <article class="job">
      <div class="job-head">
        <div><h3>${escapeHtml(job.title)}</h3><small>${job.mode === "demo" ? "演示" : "真实运行"} · #${job.id}${job.base ? " · " + escapeHtml(job.base.slice(0, 7)) : ""}</small></div>
        ${stage >= 0 ? '<button type="button" class="subtle danger" data-cancel>停止运行</button>' : ""}
      </div>
      ${job.approach ? `<p class="approach">${escapeHtml(job.approach)}</p>` : ""}
      ${job.error ? `<p class="error" role="alert">${escapeHtml(job.error)}</p>` : ""}
      ${job.tasks.length ? `<div class="task-list">${job.tasks.map((task) => renderTask(job, task, open.has(task.agent))).join("")}</div>`
        : stage >= 0 ? '<p class="approach">Claude 正在准备任务分工…</p>' : ""}
      ${job.preview || job.report ? `
        <section class="report"><h3>${job.report ? "交付汇总" : "合并预览"}</h3>
          ${job.report ? `<p>${escapeHtml(job.report)}</p>` : ""}
          ${job.preview ? `<p class="path">${escapeHtml(job.preview)}</p>` : ""}
          ${job.combined ? `<div class="actions">${fileLink(job.id, "combined.patch", "下载合并补丁")}</div>` : ""}
        </section>` : ""}
      ${job.status === "failed" && job.mode === "live" ? `<div class="actions">${fileLink(job.id, job.preview ? "summary.log" : "plan.log", "下载 Claude 日志")}</div>` : ""}
      <p id="action-error" class="error" role="alert" hidden></p>
    </article>`;
  if (sameJob && focused) {
    const next = document.getElementById(`reply-${focused}`);
    if (next) {
      next.focus({ preventScroll: true });
      next.setSelectionRange(...selection);
    }
  }
}

async function refresh() {
  if (requestInProgress) return;
  requestInProgress = true;
  try {
    const data = await api("/api/status");
    token = data.token;
    activeJob = data.active;
    $("#connection").classList.remove("offline");
    $("#connection").innerHTML = '<span class="dot"></span> 本机服务已连接';
    renderInventory(data.agents);
    selectedJob ||= activeJob || data.jobs[0]?.id;
    renderHistory(data.jobs);
    if (selectedJob) {
      const id = selectedJob;
      const job = await api(`/api/jobs/${id}`);
      if (id === selectedJob) renderRun(job);
    }
  } catch {
    token = undefined;
    $("#connection").classList.add("offline");
    $("#connection").innerHTML = '<span class="dot"></span> 本机服务未连接';
  } finally {
    requestInProgress = false;
    syncForm();
  }
}

form.addEventListener("change", () => { showError(""); syncForm(); });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const data = new FormData(form);
  if (!data.getAll("agent").length) {
    showError("请至少选择一位执行 Agent。");
    return;
  }
  submitting = true;
  syncForm();
  try {
    const job = await api("/api/jobs", {
      title: data.get("title"), brief: data.get("brief"), repo: data.get("repo"),
      mode: data.get("mode"), agents: data.getAll("agent"),
    });
    selectedJob = activeJob = job.id;
  } catch (error) {
    showError(error.message);
  } finally {
    submitting = false;
    syncForm();
    refresh();
  }
});

$("#history").addEventListener("click", (event) => {
  const button = event.target.closest("[data-job]");
  if (!button) return;
  selectedJob = button.dataset.job;
  refresh();
});

$("#run-content").addEventListener("input", (event) => {
  const agent = event.target.dataset.reply;
  if (agent && shownJob) manualDrafts.set(`${shownJob.id}/${agent}`, event.target.value);
});

$("#run-content").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || !shownJob) return;
  const job = shownJob;
  const alert = $("#action-error");
  alert.hidden = true;
  button.disabled = true;
  try {
    if ("cancel" in button.dataset) {
      await api(`/api/jobs/${job.id}/cancel`, {});
    } else if (button.dataset.copy) {
      const task = job.tasks.find(({ agent }) => agent === button.dataset.copy);
      await navigator.clipboard.writeText(task.prompt);
      button.textContent = "已复制";
    } else if (button.dataset.submit || button.dataset.skip) {
      const agent = button.dataset.submit || button.dataset.skip;
      const key = `${job.id}/${agent}`;
      await api(`/api/jobs/${job.id}/result`, {
        agent, text: manualDrafts.get(key) || "", skip: Boolean(button.dataset.skip),
      });
      manualDrafts.delete(key);
    }
  } catch (error) {
    alert.textContent = error.message;
    alert.hidden = false;
  } finally {
    button.disabled = false;
    refresh();
  }
});

syncForm();
refresh();
setInterval(refresh, 1100);
