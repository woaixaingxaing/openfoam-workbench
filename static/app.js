/* OpenFOAM 工作台 — 前端控制器
 * 纯原生 JavaScript，无外部依赖。所有文案为简体中文。
 */
(() => {
  "use strict";

  const el = (id) => document.getElementById(id);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const enc = encodeURIComponent;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const FONTS = [15, 16.5, 18, 20, 22];
  const FONT_BASE = 18;
  const COLORS = {
    teal: "#30b0c7",
    blue: "#0071e3",
    amber: "#ff9500",
    red: "#ff3b30",
    green: "#34c759",
    violet: "#af52de",
    grid: "rgba(60,60,67,.12)",
    text: "#6e6e73",
    dim: "#86868b",
  };
  const LINE_COLORS = [COLORS.teal, COLORS.blue, COLORS.amber, COLORS.violet, COLORS.red, COLORS.green];
  const CHART_MONO = '"SF Mono", "Cascadia Mono", "JetBrains Mono", Consolas, monospace';
  const CHART_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif';
  function chartFont(sizeEm, family = CHART_MONO) {
    const base = parseFloat(getComputedStyle(document.documentElement).fontSize) || 18;
    return `${Math.max(10, Math.round(base * sizeEm))}px ${family}`;
  }
  const RESERVED_RESIDUALS = new Set(["t", "exec", "co", "coMean", "dt", "cont"]);
  const FIELD_ORDER = ["p", "Ux", "Uy", "Uz", "k", "epsilon", "omega", "nut"];
  const VECTOR_FIELDS = new Set(["U", "vorticity"]);

  const STATE_META = {
    running: { label: "计算中", cls: "running" },
    stopping: { label: "停止中", cls: "running" },
    completed: { label: "已完成", cls: "completed" },
    stopped: { label: "已停止", cls: "stopped" },
    error: { label: "出错", cls: "error" },
    ready: { label: "待计算", cls: "ready" },
  };

  const FIELD_LABELS = {
    U: "速度 U",
    p: "压力 p",
    vorticity: "涡量 vorticity",
    k: "湍动能 k",
    epsilon: "耗散率 ε",
    omega: "比耗散率 ω",
    nut: "湍流黏度 νt",
    nuTilda: "修正黏度 ν̃",
    T: "温度 T",
    alphat: "热扩散率 αt",
  };

  const LUTS = {
    coolwarm: "linear-gradient(90deg,#3b4cc0,#7396f5,#dddddd,#f4a582,#b40426)",
    viridis: "linear-gradient(90deg,#440154,#3b528b,#21918c,#5ec962,#fde725)",
    turbo: "linear-gradient(90deg,#30123b,#4686fb,#1ae4b6,#a2fc3c,#faba39,#e34c2d,#7a0403)",
    jet: "linear-gradient(90deg,#00007f,#0000ff,#00ffff,#7fff7f,#ffff00,#ff0000,#7f0000)",
    inferno: "linear-gradient(90deg,#000004,#320a5a,#781c6d,#bb3654,#ed6925,#fbb61a,#fcffa4)",
    plasma: "linear-gradient(90deg,#0d0887,#6a00a8,#b12a90,#e16462,#fca636,#f0f921)",
    grayscale: "linear-gradient(90deg,#111,#555,#999,#ccc,#fff)",
  };

  const state = {
    env: null,
    cases: [],
    caseName: null,
    detail: null,
    progress: null,
    online: false,
    tab: "overview",
    busy: { progress: false, state: false },
    font: 18,
    // 日志
    logName: null,
    logFile: null,
    logLines: null,
    logMeta: "",
    logFetched: 0,
    // 力系数
    forces: null,
    forcesFor: null,
    // 字典
    dictPath: null,
    dictDirty: false,
    dictSavedText: "",
    // 任务
    renderJob: null,
    renderBusy: false,
    meshLines: null,
    meshCase: null,
    modalSerial: 0,
    modalOnClose: null,
    lastProgressState: null,
  };

  // ------------------------------------------------------------------ //
  // 基础工具
  // ------------------------------------------------------------------ //

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function fmtNum(value, digits = 4) {
    if (value === null || value === undefined || value === "") return "—";
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (n === 0) return "0";
    const abs = Math.abs(n);
    if (abs >= 1e6 || abs < 1e-4) {
      return n.toExponential(2).replace("e+", "e");
    }
    return String(parseFloat(n.toFixed(digits)));
  }

  function fmtSci(value, digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return n === 0 ? "0" : "—";
    return n.toExponential(digits);
  }

  function fmtRange(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const a = Math.abs(n);
    if (a === 0) return "0";
    if (a >= 0.01 && a < 10000) return String(parseFloat(n.toPrecision(3)));
    return n.toExponential(2);
  }

  function fmtInt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return Math.round(n).toLocaleString("zh-CN");
  }

  function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  }

  function fmtDuration(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n)) return "—";
    if (n < 1) return `${n.toFixed(2)} 秒`;
    const s = Math.round(n);
    if (s < 60) return `${s} 秒`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h} 时 ${String(m).padStart(2, "0")} 分`;
    return `${m} 分 ${String(r).padStart(2, "0")} 秒`;
  }

  function shortClock(iso) {
    if (!iso) return "—";
    const text = String(iso);
    const m = text.match(/(\d{2}:\d{2}:\d{2})/);
    return m ? m[1] : text;
  }

  function stateMeta(name) {
    return STATE_META[name] || STATE_META.ready;
  }

  function fieldLabel(name) {
    return FIELD_LABELS[name] || name;
  }

  async function api(path, options) {
    const opts = Object.assign({ cache: "no-store" }, options || {});
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = null; }
    }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || `请求失败（HTTP ${res.status}）`);
      err.status = res.status;
      err.detail = data && data.detail;
      throw err;
    }
    return data || {};
  }

  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function errorText(err) {
    let text = (err && err.message) || String(err || "未知错误");
    if (err && err.detail) {
      const detail = Array.isArray(err.detail) ? err.detail.join("\n") : (typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail));
      if (detail && !text.includes(detail)) text += `\n${detail}`;
    }
    return text;
  }

  function alertHtml(err) {
    const detail = errorText(err);
    return `<div class="alert bad">${esc(detail).replace(/\n/g, "<br>")}</div>`;
  }

  function toast(message, type = "ok", title = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.innerHTML = `${title ? `<b>${esc(title)}</b>` : ""}${esc(message).replace(/\n/g, "<br>")}`;
    el("toasts").appendChild(node);
    window.setTimeout(() => {
      node.style.opacity = "0";
      node.style.transform = "translateY(6px)";
      node.style.transition = "opacity .18s ease, transform .18s ease";
      window.setTimeout(() => node.remove(), 220);
    }, type === "error" ? 7000 : 4600);
  }

  function caseQuery(extra = "") {
    return `name=${enc(state.caseName || "")}${extra}`;
  }

  // ------------------------------------------------------------------ //
  // 字体 / 顶栏
  // ------------------------------------------------------------------ //

  function applyFont(px, persist = true) {
    const value = Number(px) || FONT_BASE;
    state.font = value;
    document.documentElement.style.fontSize = `${value}px`;
    if (persist) localStorage.setItem("ofwb.font", String(value));
    const nearest = FONTS.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best), FONTS[0]);
    el("fontLabel").textContent = `${Math.round((value / FONT_BASE) * 100)}%`;
    el("fontMinus").disabled = value <= FONTS[0] + 1e-9;
    el("fontPlus").disabled = value >= FONTS[FONTS.length - 1] - 1e-9;
    state.fontIndex = FONTS.indexOf(nearest);
    window.setTimeout(redrawCharts, 60);
  }

  function stepFont(direction) {
    let idx = FONTS.findIndex((v) => Math.abs(v - state.font) < 1e-9);
    if (idx < 0) idx = FONTS.indexOf(FONT_BASE);
    idx = Math.max(0, Math.min(FONTS.length - 1, idx + direction));
    applyFont(FONTS[idx]);
  }

  function renderEnv() {
    const env = state.env || {};
    const version = env.version && env.version !== "?" ? env.version : "14";
    const cores = env.cores ? `${env.cores} 核` : "核数未知";
    const mem = env.memAvail !== null && env.memAvail !== undefined ? `可用内存 ${fmtNum(env.memAvail, 1)} GB` : "";
    el("envLine").textContent = `OpenFOAM v${version} · WSL2 · ${cores}${env.paraview === false ? " · ParaView 不可用" : " · WSLg 图形界面就绪"}`;
    el("envChip").textContent = [cores, mem].filter(Boolean).join(" · ");
    el("sideUptime").textContent = env.uptime !== null && env.uptime !== undefined ? `服务运行 ${fmtDuration(env.uptime)} · 端口 8848` : "";
  }

  function setOnline(ok) {
    state.online = Boolean(ok);
    const pill = el("svcPill");
    pill.className = ok ? "svc ok" : "svc off";
    const label = ok ? "服务在线" : "连接断开";
    pill.setAttribute("aria-label", label);
    pill.title = label;
    el("svcText").textContent = label;
    el("sideServer").textContent = ok ? "本地服务在线 · 端口 8848" : "本地服务连接中断";
  }

  // ------------------------------------------------------------------ //
  // 算例列表
  // ------------------------------------------------------------------ //

  function caseProgressPct(item) {
    const end = Number(item.endTime);
    const start = Number(item.startTime) || 0;
    const latest = Number(item.latest);
    if (!Number.isFinite(end) || !Number.isFinite(latest) || end <= start) return 0;
    return Math.max(0, Math.min(100, ((latest - start) / (end - start)) * 100));
  }

  function caseItemHtml(item) {
    const meta = stateMeta(item.state);
    const completed = meta.cls === "completed";
    const noWrites = completed && !(Number(item.latest) > 0) && Number(item.endTime) > 0;
    const pct = completed ? 100 : Math.round(caseProgressPct(item));
    const t = item.latest !== null && item.latest !== undefined ? `t=${fmtNum(item.latest, 5)}` : "尚未计算";
    const end = item.endTime !== null && item.endTime !== undefined ? ` / ${fmtNum(item.endTime, 5)} s` : "";
    const note = noWrites ? " · 计算完成但没有写出时间目录" : "";
    return `<button class="case-item${item.name === state.caseName ? " active" : ""}" data-case="${esc(item.name)}" title="${esc(item.name)}${esc(end)}${esc(note)}">
      <div class="ci-main">
        <div class="nm"><span class="dot ${meta.cls}"></span><span class="name">${esc(item.name)}</span></div>
        <div class="sub">${esc(item.solver || "—")} · ${t}</div>
      </div>
      <div class="ci-right"><div class="ci-pct">${noWrites ? "—" : `${pct}%`}</div><div class="ci-state${noWrites ? " warn" : ""}">${noWrites ? "完成·无写盘" : meta.label}</div></div>
    </button>`;
  }

  function renderCases() {
    const query = (el("caseSearch").value || "").trim().toLowerCase();
    const list = state.cases.filter((item) => !query || item.name.toLowerCase().includes(query));
    el("caseCount").textContent = String(state.cases.length);
    el("caseList").innerHTML = list.length
      ? list.map(caseItemHtml).join("")
      : `<div class="placeholder" style="padding:18px 8px">${state.cases.length ? "没有匹配的算例" : "还没有算例"}</div>`;
  }

  function updateSidebarProgress(p) {
    const item = state.cases.find((c) => c.name === p.name);
    if (item) {
      item.state = p.state;
      item.running = p.state === "running" || p.state === "stopping";
    }
    const node = el("caseList").querySelector(`[data-case="${window.CSS && CSS.escape ? CSS.escape(p.name) : p.name.replace(/"/g, '\\"')}"]`);
    if (!node) return;
    const meta = stateMeta(p.state);
    const dot = node.querySelector(".dot");
    if (dot) dot.className = `dot ${meta.cls}`;
    const noWrites = p.state === "completed" && item && !(Number(item.latest) > 0) && Number(item.endTime) > 0;
    const pct = node.querySelector(".ci-pct");
    if (pct) pct.textContent = noWrites ? "—" : `${p.state === "completed" ? 100 : Math.round(p.progressPct !== undefined ? p.progressPct : 0)}%`;
    const stateText = node.querySelector(".ci-state");
    if (stateText) {
      stateText.textContent = noWrites ? "完成·无写盘" : meta.label;
      stateText.className = `ci-state${noWrites ? " warn" : ""}`;
    }
  }

  // ------------------------------------------------------------------ //
  // 空状态 / 载入
  // ------------------------------------------------------------------ //

  function showEmpty(title, subtitle, retry = true) {
    el("caseView").hidden = true;
    const box = el("emptyState");
    box.hidden = false;
    box.innerHTML = `<div class="orb"><span class="mono" style="font-size:1.7rem;color:var(--amber)">!</span></div>
      <h2>${esc(title)}</h2><p>${esc(subtitle || "")}</p>
      ${retry ? '<button class="btn primary" id="retryBtn">重新连接</button>' : ""}`;
    const btn = el("retryBtn");
    if (btn) btn.addEventListener("click", () => loadState());
  }

  function showLoading(title, subtitle) {
    el("caseView").hidden = true;
    const box = el("emptyState");
    box.hidden = false;
    box.innerHTML = `<div class="orb"><span class="spinner large"></span></div><h2>${esc(title)}</h2><p>${esc(subtitle || "")}</p>`;
  }

  // ------------------------------------------------------------------ //
  // 状态加载
  // ------------------------------------------------------------------ //

  async function loadState() {
    if (state.busy.state) return;
    state.busy.state = true;
    try {
      const data = await api("/api/state");
      setOnline(true);
      state.env = data.env || {};
      state.cases = data.cases || [];
      renderEnv();
      renderCases();
      const names = state.cases.map((c) => c.name);
      const remembered = localStorage.getItem("ofwb.case");
      if (!state.detail || !state.caseName || !names.includes(state.caseName)) {
        const pick = names.includes(state.caseName) ? state.caseName : (names.includes(remembered) ? remembered : names[0]);
        if (pick) {
          await selectCase(pick, { silent: true });
        } else {
          showEmpty("还没有算例", "在 /home/ubuntu/OpenFOAM/mcp-cases 中创建算例后，点击“重新连接”。");
        }
      }
    } catch (err) {
      setOnline(false);
      if (!state.detail) showEmpty("无法连接本地服务", `${errorText(err)}\n请确认 WSL 中的 openfoam-gui 服务正在运行。`);
      console.warn("加载状态失败", err);
    } finally {
      state.busy.state = false;
    }
  }

  async function selectCase(name, options = {}) {
    if (!name) return;
    const silent = Boolean(options.silent);
    state.caseName = name;
    localStorage.setItem("ofwb.case", name);
    renderCases();
    if (!state.detail) showLoading("正在载入算例", `${name} · 读取网格、日志与云图…`);
    try {
      const detail = await api(`/api/case?${caseQuery()}`);
      if (state.caseName !== name) return;
      state.detail = detail;
      state.progress = detail.progress || null;
      state.lastProgressState = state.progress ? state.progress.state : null;
      state.logName = null;
      state.logFile = null;
      state.logLines = null;
      state.logMeta = "";
      state.forces = null;
      state.forcesFor = null;
      state.dictPath = null;
      state.dictDirty = false;
      state.dictSavedText = "";
      state.meshLines = null;
      state.meshCase = null;
      state.renderJob = null;
      state.renderBusy = false;
      el("renderJobBox").hidden = true;
      el("renderJobBox").className = "jobbox";
      el("renderBtn").disabled = false;
      el("renderBtn").innerHTML = `<svg class="ic"><use href="#i-camera"/></svg><span>生成当前帧</span>`;
      el("dictText").value = "";
      el("dictText").classList.remove("dirty");
      el("dictSave").disabled = true;
      el("dictStatus").textContent = "";
      el("dictPath").textContent = "选择文件";
      el("forceSelect").innerHTML = "";
      el("arefBadge").textContent = "Aref —";
      el("forceStats").innerHTML = "";
      el("forceHint").textContent = "";
      el("logView").textContent = "正在读取日志…";
      el("emptyState").hidden = true;
      el("caseView").hidden = false;
      renderHeader();
      renderParams();
      renderFacts();
      renderRunPanel(state.progress || { state: "ready" });
      renderMiniGallery();
      renderForceMini();
      loadForces(null, { silent: true });
      fillRenderFields();
      fillLogSelect();
      renderDictList();
      renderMeshBox(state.detail.mesh);
      renderGallery();
      if (state.tab === "monitor") loadLog({ silent: true });
      if (state.tab === "data") loadForces(null, { silent: true });
      if (state.tab === "dict" && !state.dictPath) autoOpenDict();
    } catch (err) {
      console.warn(err);
      if (!silent) toast(errorText(err), "error", "载入算例失败");
      if (!state.detail) showEmpty("载入算例失败", errorText(err));
    }
  }

  async function refreshDetail(options = {}) {
    const quiet = options.silent !== false;
    const includeForm = Boolean(options.includeForm);
    if (!state.caseName) return;
    const name = state.caseName;
    try {
      const detail = await api(`/api/case?${caseQuery()}`);
      if (state.caseName !== name) return;
      state.detail = detail;
      if (detail.progress) state.progress = detail.progress;
      renderHeader();
      renderFacts();
      renderRunPanel(state.progress || { state: "ready" });
      fillRenderFields();
      fillLogSelect();
      renderDictList();
      renderMeshBox(detail.mesh);
      renderGallery();
      renderMiniGallery();
      renderForceMini();
      loadForces(state.forces && state.forces.data ? state.forces.data.id : null, { silent: true });
      if (includeForm) renderParams();
      if (state.tab === "monitor") {
        drawResidualChart(state.progress);
        loadLog({ silent: true });
      }
      if (state.tab === "data") loadForces(state.forces && state.forces.data ? state.forces.data.id : null, { silent: true });
    } catch (err) {
      if (!quiet) toast(errorText(err), "error", "刷新失败");
    }
  }

  // ------------------------------------------------------------------ //
  // 标题 / 运行面板
  // ------------------------------------------------------------------ //

  function renderHeader() {
    const d = state.detail;
    if (!d) return;
    el("casePath").textContent = d.path || d.name;
    el("caseTitle").textContent = d.name;
    renderChips(state.progress);
    updateStatePill(state.progress ? state.progress.state : "ready");
    updateRunButtons();
  }

  function renderChips(p) {
    const d = state.detail;
    if (!d) return;
    const t = p && p.time !== null && p.time !== undefined ? p.time : d.latest;
    const written = Number(d.latest);
    const ahead = p && p.time !== null && p.time !== undefined && Number.isFinite(written) && Number(p.time) > written + 1e-9;
    const mesh = d.mesh && d.mesh.checked ? `${fmtInt(d.mesh.cells)} 单元` : "网格未检查";
    const ranks = p && p.ranks ? p.ranks : (d.processorDirs || 0);
    el("caseChips").innerHTML = [
      `<span class="chip">求解器 <b>${esc(d.solver || "—")}</b></span>`,
      `<span class="chip${d.mesh && d.mesh.ok ? " good" : ""}">${mesh}</span>`,
      `<span class="chip${ahead ? " warn" : ""}">${ahead ? "求解至" : "最新写盘"} <b>t = ${fmtNum(t, 6)} s</b></span>`,
      `<span class="chip">${ranks ? `<b>${ranks}</b> 核并行` : "<b>串行</b>"}</span>`,
      `<span class="chip"><b>${fmtNum(d.sizeMb, 1)}</b> MB</span>`,
    ].join("");
  }

  function updateStatePill(name) {
    const meta = stateMeta(name);
    const pill = el("caseState");
    pill.className = `state-pill ${meta.cls}`;
    pill.textContent = meta.label;
  }

  function updateRunButtons() {
    const st = state.progress ? state.progress.state : "ready";
    const busy = st === "running" || st === "stopping";
    el("runBtn").disabled = busy;
    el("stopBtn").disabled = !busy;
    el("stopBtn").querySelector("span").textContent = st === "stopping" ? "停止中…" : "停止";
  }

  function kpi(label, value, sub) {
    return `<div class="kpi"><div class="k-label">${esc(label)}</div><div class="k-val">${esc(value)}</div><div class="k-sub">${esc(sub || "")}</div></div>`;
  }

  function renderRunPanel(p) {
    if (!p) p = { state: "ready" };
    const d = state.detail || {};
    const meta = stateMeta(p.state);
    el("runStateLabel").textContent = meta.label;
    const live = el("liveDot");
    live.className = "live" + (p.state === "running" || p.state === "stopping" ? " on" : p.state === "completed" ? " done" : p.state === "error" ? " err" : "");
    const ranks = p.ranks || d.processorDirs;
    el("runSub").textContent = p.state === "running" || p.state === "stopping"
      ? `foamRun${ranks ? ` · ${ranks} 核` : " · 串行"}`
      : (d.solver ? `${d.solver}` : "foamRun");
    el("runUpdated").textContent = p.updated ? `日志更新 ${shortClock(p.updated)}` : "等待日志";
    const pct = Math.max(0, Math.min(100, Number(p.pct) || 0));
    el("progressFill").style.width = `${pct}%`;
    el("pctText").textContent = `${pct.toFixed(pct > 0 && pct < 10 ? 1 : 0)}%`;
    el("progressTrack").className = "bar" + (p.state === "running" || p.state === "stopping" ? " running" : p.state === "completed" ? " done" : p.state === "error" ? " error" : "");
    el("timeNow").textContent = p.time !== null && p.time !== undefined ? fmtNum(p.time, 6) : "—";
    el("timeEnd").textContent = p.endTime !== null && p.endTime !== undefined ? `/ ${fmtNum(p.endTime, 6)} s` : "/ —";

    const history = Array.isArray(p.history) ? p.history : [];
    const last = history.length ? history[history.length - 1] : {};
    const dt = last.dt !== undefined ? last.dt : p.dt;
    const co = p.co;
    const cont = last.cont;
    el("kpis").innerHTML = [
      kpi("时间步长", dt !== null && dt !== undefined ? fmtNum(dt, 6) : "—", "deltaT · s"),
      kpi("库朗数", co !== null && co !== undefined ? fmtNum(co, 4) : "—", p.coMean !== null && p.coMean !== undefined ? `平均 ${fmtNum(p.coMean, 4)}` : "Courant"),
      kpi("压力残差", p.p !== null && p.p !== undefined ? fmtSci(p.p) : "—", "最终 p 残差"),
      kpi("连续误差", cont !== null && cont !== undefined ? fmtSci(cont) : "—", "continuity"),
      kpi("求解耗时", p.exec !== null && p.exec !== undefined ? fmtDuration(p.exec) : "—", p.iterations ? `${p.iterations} 个时间步` : "ExecutionTime"),
      kpi("预计剩余", p.eta !== null && p.eta !== undefined ? fmtDuration(p.eta) : "—", p.rate !== null && p.rate !== undefined ? `速度 ${fmtNum(p.rate, 2)} s/s` : "尚无估算"),
    ].join("");

    const bits = [];
    if (p.pids && p.pids.length) bits.push(`<span>PID ${esc(p.pids.join(", "))}</span>`);
    if (p.log) bits.push(`<span>${esc(p.log)}${p.logSize ? ` · ${fmtBytes(p.logSize)}` : ""}</span>`);
    if (p.state === "error" && p.error) bits.push(`<span class="bad">${esc(p.error)}</span>`);
    else if (p.state === "ready") bits.push('<span>尚未启动；点击“启动计算”选择起始方式与并行核数。</span>');
    else if (p.state === "completed") {
      const written = Number(d.latest);
      if (Number.isFinite(written) && p.time !== null && p.time !== undefined && written + 1e-9 < Number(p.time)) {
        bits.push(`<span class="warn">求解已结束，但磁盘上的最新时间只到 t=${fmtNum(written, 6)} s；检查写出间隔，或手动保存结果。</span>`);
      } else {
        bits.push('<span class="ok">计算已完成，结果已写盘。</span>');
      }
    }
    else if (p.state === "stopped") bits.push('<span class="warn">已停止；可从最新时间继续计算。</span>');
    else if (p.state === "stopping") bits.push('<span class="warn">正在等待求解器写完当前时间步…</span>');
    else if (p.state === "running") bits.push('<span class="ok">求解进行中，页面会自动刷新。</span>');
    if (d.source === "decomposed" && (p.state === "running" || p.state === "stopping")) {
      bits.push('<span>最新结果位于 processor*，云图读取已写出时间。</span>');
    }
    el("runFoot").innerHTML = bits.join("");
    renderChips(p);
    updateStatePill(p.state);
    updateRunButtons();
  }

  async function pollProgress() {
    if (!state.caseName || !state.detail || state.busy.progress || document.hidden) return;
    state.busy.progress = true;
    const name = state.caseName;
    const previous = state.progress ? state.progress.state : null;
    try {
      const p = await api(`/api/progress?${caseQuery()}`);
      if (state.caseName !== name) return;
      p.name = name;
      state.progress = p;
      const end = Number(p.endTime);
      const start = Number(p.startTime) || 0;
      p.progressPct = end > start && p.time !== null ? ((p.time - start) / (end - start)) * 100 : 0;
      renderRunPanel(p);
      updateSidebarProgress(p);
      if (state.tab === "monitor") drawResidualChart(p);
      if (p.state !== previous) {
        state.lastProgressState = p.state;
        if (p.state === "completed") {
          toast("计算完成，正在刷新写盘结果。", "ok", "计算完成");
          refreshDetail({ silent: true, includeForm: true });
        } else if (p.state === "error") {
          toast(p.error || "求解器异常退出，请查看日志。", "error", "计算中断");
          refreshDetail({ silent: true, includeForm: true });
        } else if (p.state === "running" && previous !== "stopping") {
          toast("求解器已启动，正在实时输出日志。", "ok", "计算已开始");
        } else if (p.state === "stopped") {
          toast("求解器已停止，已写出的结果保留。", "warn", "已停止");
          refreshDetail({ silent: true, includeForm: true });
        }
      }
    } catch (err) {
      setOnline(false);
    } finally {
      state.busy.progress = false;
    }
  }

  // ------------------------------------------------------------------ //
  // 概览：参数 / 概况 / 力系数 / 小画廊
  // ------------------------------------------------------------------ //

  function renderParams() {
    const d = state.detail;
    if (!d) return;
    const c = d.control || {};
    const form = el("paramForm");
    form.elements.startFrom.value = c.startFrom || "latestTime";
    const numeric = ["startTime", "endTime", "deltaT", "maxCo", "writeInterval"];
    numeric.forEach((key) => {
      form.elements[key].value = c[key] === null || c[key] === undefined ? "" : String(c[key]);
    });
    form.elements.adjustTimeStep.checked = String(c.adjustTimeStep || "no").toLowerCase() === "yes";
    el("paramHint").className = "form-hint";
    el("paramHint").textContent = c.writeControl && c.writeControl !== "runTime"
      ? `writeControl = ${c.writeControl}；写出间隔按该模式解释`
      : "参数写入 system/controlDict，保存后立即生效";
  }

  async function saveParams(event) {
    event.preventDefault();
    if (!state.detail) return;
    const form = el("paramForm");
    const wanted = {
      startFrom: form.elements.startFrom.value,
      startTime: form.elements.startTime.value.trim(),
      endTime: form.elements.endTime.value.trim(),
      deltaT: form.elements.deltaT.value.trim(),
      maxCo: form.elements.maxCo.value.trim(),
      writeInterval: form.elements.writeInterval.value.trim(),
      adjustTimeStep: form.elements.adjustTimeStep.checked ? "yes" : "no",
    };
    const required = ["startTime", "endTime", "deltaT", "writeInterval"];
    const missing = required.filter((key) => !wanted[key] || !Number.isFinite(Number(wanted[key])));
    if (missing.length) {
      const hint = el("paramHint");
      hint.className = "form-hint bad";
      hint.textContent = "请填写有效的数值参数";
      return;
    }
    if (wanted.adjustTimeStep === "yes" && (!wanted.maxCo || !Number.isFinite(Number(wanted.maxCo)))) {
      const hint = el("paramHint");
      hint.className = "form-hint bad";
      hint.textContent = "启用自适应时间步时，必须填写最大库朗数";
      return;
    }
    const control = state.detail.control || {};
    const changed = Object.keys(wanted).filter((key) => {
      if (key === "maxCo" && !wanted[key]) return false;
      if (key === "startFrom" || key === "adjustTimeStep") return String(control[key] || "") !== wanted[key];
      const a = Number(control[key]);
      const b = Number(wanted[key]);
      return !Number.isFinite(a) || Math.abs(a - b) > 1e-12;
    });
    const hint = el("paramHint");
    if (!changed.length) {
      hint.className = "form-hint good";
      hint.textContent = "参数没有变化";
      return;
    }
    const button = el("saveParams");
    button.disabled = true;
    button.textContent = "保存中…";
    hint.className = "form-hint";
    hint.textContent = `正在写入 ${changed.length} 项参数…`;
    try {
      let latestControl = control;
      for (const key of changed) {
        const result = await post("/api/control", { name: state.caseName, key, value: wanted[key] });
        latestControl = result.control || latestControl;
      }
      state.detail.control = latestControl;
      state.detail.startTime = latestControl.startTimeNum;
      state.detail.endTime = latestControl.endTimeNum;
      renderParams();
      hint.className = "form-hint good";
      hint.textContent = `已保存 ${changed.length} 项 · ${new Date().toLocaleTimeString("zh-CN")}`;
      toast(`已更新 ${changed.map((key) => key).join("、")}`, "ok", "参数已保存");
    } catch (err) {
      hint.className = "form-hint bad";
      hint.textContent = errorText(err).split("\n")[0];
      toast(errorText(err), "error", "参数保存失败");
    } finally {
      button.disabled = false;
      button.textContent = "保存参数";
    }
  }

  function renderFacts() {
    const d = state.detail;
    if (!d) return;
    const c = d.control || {};
    const mesh = d.mesh && d.mesh.checked
      ? `${fmtInt(d.mesh.cells)} 单元${d.mesh.ok ? " · 通过" : " · 有问题"}`
      : "未运行 checkMesh";
    const latest = d.latest !== null && d.latest !== undefined ? `t = ${fmtNum(d.latest, 6)} s` : "尚未写盘";
    const source = d.source === "decomposed" ? "processor* 并行结果" : "根目录串行结果";
    const range = c.startTimeNum !== null && c.startTimeNum !== undefined && c.endTimeNum !== null && c.endTimeNum !== undefined
      ? `${fmtNum(c.startTimeNum, 6)} → ${fmtNum(c.endTimeNum, 6)} s`
      : "未设置";
    const facts = [
      ["算例路径", d.path, false],
      ["求解器", d.solver || "—", false],
      ["网格单元", mesh, d.mesh && d.mesh.ok],
      ["时间范围", range, false],
      ["最新结果", latest, false],
      ["数据来源", source, false],
      ["并行分解", d.processorDirs ? `${d.processorDirs} 个 processor 目录` : "未分解（串行）", false],
      ["算例大小", `${fmtNum(d.sizeMb, 1)} MB`, false],
      ["最后修改", d.modified || "—", false],
    ];
    el("facts").innerHTML = facts.map(([key, value, good]) => `<div class="fact"><span>${esc(key)}</span><b class="${good ? "good" : ""}" title="${esc(value)}">${esc(value)}</b></div>`).join("");
  }

  function renderForceMini() {
    const box = el("forceMini");
    const data = state.forces && state.forces.available ? state.forces.data : null;
    if (!data) {
      box.innerHTML = '<div class="placeholder" style="grid-column:1/-1;padding:6px 0">尚未生成升阻力系数。带 forceCoeffs 的算例运行后会自动写入 postProcessing。</div>';
      return;
    }
    const stats = data.stats || {};
    box.innerHTML = `
      <div class="mini-stat"><span>平均 Cd</span><b>${fmtNum(stats.cdMean, 4)}</b><small>Aref ${fmtNum(data.Aref, 4)}</small></div>
      <div class="mini-stat"><span>Cl 振幅</span><b>${fmtNum(stats.clAmp, 4)}</b><small>${fmtNum(stats.clMin, 3)} → ${fmtNum(stats.clMax, 3)}</small></div>
      <div class="mini-stat"><span>振荡周期</span><b>${stats.period ? `${fmtNum(stats.period, 3)} s` : "—"}</b><small>${stats.n ? `${stats.n} 个采样点` : ""}</small></div>`;
  }

  function renderMiniGallery() {
    const box = el("miniGallery");
    const images = (state.detail && state.detail.images) || [];
    if (!images.length) {
      box.innerHTML = '<div class="placeholder" style="grid-column:1/-1;padding:6px 0">还没有云图。打开“云图”页生成第一张结果图。</div>';
      return;
    }
    box.innerHTML = images.slice(0, 3).map((img, index) => `<button class="mini-shot" data-img="${index}" title="${esc(img.name)}">
      <img loading="lazy" src="${esc(img.url)}" alt="${esc(img.name)}"><span>${esc(img.name)}</span></button>`).join("");
  }

  // ------------------------------------------------------------------ //
  // 监控：残差 / 日志
  // ------------------------------------------------------------------ //

  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function drawEmptyChart(ctx, width, height, text) {
    ctx.fillStyle = COLORS.dim;
    ctx.font = chartFont(.78, CHART_SANS);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, width / 2, height / 2);
  }

  function drawAxes(ctx, box, t0, t1, yLabels, leftColor = COLORS.dim) {
    const { left, right, top, bottom } = box;
    ctx.strokeStyle = COLORS.grid;
    ctx.fillStyle = COLORS.dim;
    ctx.lineWidth = 1;
    ctx.font = chartFont(.66);
    ctx.textBaseline = "middle";
    yLabels.forEach((label, index) => {
      const y = top + ((bottom - top) * index) / Math.max(1, yLabels.length - 1);
      ctx.beginPath();
      ctx.moveTo(left, y + 0.5);
      ctx.lineTo(right, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = leftColor;
      ctx.textAlign = "right";
      ctx.fillText(label, left - 8, y);
    });
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.dim;
    const ticks = 4;
    for (let i = 0; i <= ticks; i += 1) {
      const x = left + ((right - left) * i) / ticks;
      const value = t0 + ((t1 - t0) * i) / ticks;
      ctx.fillText(fmtNum(value, 3), x, bottom + 16);
      if (i > 0 && i < ticks) {
        ctx.strokeStyle = "rgba(60,60,67,.055)";
        ctx.beginPath();
        ctx.moveTo(x + 0.5, top);
        ctx.lineTo(x + 0.5, bottom);
        ctx.stroke();
      }
    }
  }

  function drawResidualChart(p) {
    const canvas = el("resChart");
    if (!canvas || !canvas.offsetParent) return;
    const { ctx, width, height } = fitCanvas(canvas);
    const history = (p && Array.isArray(p.history) ? p.history : []).filter((row) => Number.isFinite(Number(row.t)));
    const legend = el("resLegend");
    if (history.length < 2) {
      drawEmptyChart(ctx, width, height, "暂无残差数据，启动计算后会自动绘制");
      legend.innerHTML = "";
      return;
    }
    const keys = new Set();
    history.forEach((row) => Object.keys(row).forEach((key) => {
      if (!RESERVED_RESIDUALS.has(key) && Number.isFinite(Number(row[key]))) keys.add(key);
    }));
    let fields = FIELD_ORDER.filter((key) => keys.has(key));
    if (!fields.length) fields = Array.from(keys).slice(0, 5);
    fields = fields.slice(0, 5);

    let minLog = Infinity;
    let maxLog = -Infinity;
    const series = fields.map((field) => {
      const points = [];
      history.forEach((row) => {
        const t = Number(row.t);
        const value = Number(row[field]);
        if (Number.isFinite(value) && value > 0 && Number.isFinite(t)) {
          points.push([t, value]);
          const l = Math.log10(value);
          if (l < minLog) minLog = l;
          if (l > maxLog) maxLog = l;
        }
      });
      return { field, points };
    }).filter((item) => item.points.length);
    if (!series.length) {
      drawEmptyChart(ctx, width, height, "残差数据均为零或不可解析");
      legend.innerHTML = "";
      return;
    }
    let lo = Math.floor(minLog);
    let hi = Math.ceil(maxLog);
    if (hi - lo < 3) hi = lo + 3;
    const t0 = history[0].t;
    const t1 = history[history.length - 1].t;
    const box = { left: 54, right: width - 14, top: 12, bottom: height - 28 };
    const yFor = (value) => box.bottom - ((Math.log10(value) - lo) / (hi - lo)) * (box.bottom - box.top);
    const xFor = (t) => box.left + ((t - t0) / Math.max(1e-12, t1 - t0)) * (box.right - box.left);
    const labels = [];
    const step = Math.max(1, Math.ceil((hi - lo) / 6));
    for (let e = hi; e >= lo; e -= step) labels.push(`1e${e}`);
    drawAxes(ctx, box, t0, t1, labels);

    series.forEach((item, index) => {
      const color = LINE_COLORS[index % LINE_COLORS.length];
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = item.field === "p" ? 1.8 : 1.3;
      item.points.forEach(([t, value], pointIndex) => {
        const x = xFor(t);
        const y = yFor(value);
        if (pointIndex === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      const lastPoint = item.points[item.points.length - 1];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(xFor(lastPoint[0]), yFor(lastPoint[1]), 2.3, 0, Math.PI * 2);
      ctx.fill();
    });

    legend.innerHTML = series.map((item, index) => {
      const last = item.points[item.points.length - 1][1];
      return `<span class="lg"><i style="background:${LINE_COLORS[index % LINE_COLORS.length]}"></i>${esc(item.field)} <b>${fmtSci(last)}</b></span>`;
    }).join("");
  }

  function fillLogSelect() {
    const select = el("logSelect");
    const logs = (state.detail && state.detail.logs) || [];
    const current = select.value || state.logName;
    if (!logs.length) {
      select.innerHTML = '<option value="">无日志</option>';
      return;
    }
    select.innerHTML = logs.map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join("");
    const preferred = logs.some((item) => item.name === current)
      ? current
      : (logs.find((item) => item.name === "log.foamRun") || logs[0]).name;
    select.value = preferred;
  }

  function classifyLogLine(line) {
    if (/FOAM FATAL|FOAM Warning|FATAL ERROR|Segmentation fault/i.test(line)) return "lerr";
    if (/^End\s*$/.test(line)) return "lok";
    if (/^\s*Time\s*=/.test(line)) return "ltime";
    if (/Solving for|DICPCG|GAMG|smoothSolver/.test(line)) return "lsolve";
    if (/ExecutionTime|deltaT|Courant|continuity|Time =/.test(line)) return "lmeta";
    return "";
  }

  function renderLog() {
    const view = el("logView");
    const lines = state.logLines;
    if (!Array.isArray(lines)) {
      view.textContent = "选择算例后查看求解日志…";
      return;
    }
    if (!lines.length) {
      view.textContent = "日志文件目前为空。";
      return;
    }
    const filter = (el("logFilter").value || "").trim().toLowerCase();
    const filtered = filter ? lines.filter((line) => line.toLowerCase().includes(filter)) : lines;
    el("logMeta").textContent = state.logMeta + (filter ? ` · 匹配 ${filtered.length} 行` : "");
    if (!filtered.length) {
      view.textContent = "没有匹配该关键字的日志行。";
      return;
    }
    view.innerHTML = filtered.map((line) => {
      const cls = classifyLogLine(line);
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    }).join("\n");
    if (el("logAuto").checked && !filter) view.scrollTop = view.scrollHeight;
  }

  async function loadLog(options = {}) {
    const force = Boolean(options.force);
    if (!state.caseName) return;
    const select = el("logSelect");
    const file = select.value;
    if (!file) {
      state.logLines = [];
      state.logMeta = "";
      renderLog();
      return;
    }
    if (!force && state.logFile === file && state.logLines && Date.now() - state.logFetched < 1200) return;
    const name = state.caseName;
    try {
      const result = await api(`/api/log?${caseQuery(`&file=${enc(file)}&n=600`)}`);
      if (state.caseName !== name) return;
      state.logName = result.file;
      state.logFile = result.file;
      state.logLines = result.lines || [];
      state.logMeta = `${result.file} · ${fmtBytes(result.size)} · ${shortClock(result.mtime)}`;
      state.logFetched = Date.now();
      renderLog();
    } catch (err) {
      if (state.caseName !== name) return;
      state.logLines = [];
      state.logMeta = "";
      el("logView").textContent = `无法读取日志：${errorText(err)}`;
    }
  }

  // ------------------------------------------------------------------ //
  // 云图
  // ------------------------------------------------------------------ //

  function fillRenderFields() {
    const select = el("renderField");
    const fields = (state.detail && state.detail.fields) || [];
    const previous = select.value;
    if (!fields.length) {
      select.innerHTML = '<option value="">暂无可用字段</option>';
      updateRenderComponents(true);
    } else {
      select.innerHTML = fields.map((name) => `<option value="${esc(name)}">${esc(fieldLabel(name))}</option>`).join("");
      if (fields.includes(previous)) select.value = previous;
      else if (fields.includes("U")) select.value = "U";
      else select.value = fields[0];
      updateRenderComponents(true);
    }
    fillRenderTimes();
  }

  function fillRenderTimes() {
    const select = el("renderTime");
    const times = (state.detail && state.detail.timesRender) || [];
    const previous = select.value;
    const latest = times.length ? times[times.length - 1] : null;
    const options = [`<option value="">最新${latest !== null ? `（t = ${fmtNum(latest, 6)} s）` : ""}</option>`];
    times.slice(-160).reverse().forEach((t) => {
      options.push(`<option value="${esc(t)}">t = ${fmtNum(t, 6)} s</option>`);
    });
    select.innerHTML = options.join("");
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    el("renderTime").title = state.detail && state.detail.source === "decomposed"
      ? "结果来自 processor0 中已写出的时间"
      : "结果来自算例根目录中已写出的时间";
  }

  function updateRenderComponents(reset = false) {
    const field = el("renderField").value;
    const wrap = el("componentWrap");
    const select = el("renderComponent");
    const isVector = VECTOR_FIELDS.has(field);
    wrap.hidden = !isVector;
    if (!isVector) {
      select.innerHTML = '<option value="Magnitude">幅值</option>';
      return;
    }
    const previous = reset ? "" : select.value;
    select.innerHTML = [
      ["Magnitude", "幅值"],
      ["X", "X 分量"],
      ["Y", "Y 分量"],
      ["Z", "Z 分量"],
    ].map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    const preferred = field === "vorticity" ? "Z" : "Magnitude";
    select.value = ["Magnitude", "X", "Y", "Z"].includes(previous) ? previous : preferred;
  }

  function updateLutPreview() {
    const key = el("renderColormap").value;
    el("lutPreview").style.background = LUTS[key] || LUTS.coolwarm;
  }

  function renderGallery() {
    const box = el("gallery");
    const images = (state.detail && state.detail.images) || [];
    el("galleryCount").textContent = images.length ? `${images.length} 张` : "";
    if (!images.length) {
      box.innerHTML = `<div class="gallery-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-2 4 3.5"/></svg>还没有云图。选择物理场与时间，然后点击“生成当前帧”。</div>`;
      return;
    }
    box.innerHTML = images.map((img, index) => `<button class="shot" data-img="${index}" title="${esc(img.name)}">
      <img loading="lazy" src="${esc(img.url)}" alt="${esc(img.name)}">
      <div class="cap"><b>${esc(img.name)}</b><small>${esc(shortClock(img.mtime))} · ${fmtBytes(img.size)}</small></div>
    </button>`).join("");
  }

  function openLightbox(img) {
    if (!img) return;
    el("lightImg").src = img.url;
    el("lightCaption").textContent = [img.name, img.size ? fmtBytes(img.size) : "", img.mtime || ""].filter(Boolean).join(" · ");
    const download = el("lightDownload");
    download.href = img.url;
    download.setAttribute("download", img.name);
    el("lightbox").hidden = false;
  }

  function closeLightbox() {
    el("lightbox").hidden = true;
    el("lightImg").src = "";
  }

  function renderJobBox(job, meta) {
    const box = el("renderJobBox");
    box.hidden = false;
    box.className = "jobbox" + (job.status === "done" ? " done" : job.status === "error" ? " error" : "");
    const running = job.status === "queued" || job.status === "running";
    const title = job.status === "done" ? "渲染完成" : job.status === "error" ? "渲染失败" : "正在渲染…";
    const spinner = running ? '<span class="spinner" style="width:13px;height:13px"></span>' : "";
    const image = job.result && job.result.image;
    const range = job.result && job.result.range;
    let html = `<div class="job-title">${spinner}<span>${title}</span></div>
      <div>${esc(meta.fieldLabel)}${meta.time ? ` @ t = ${esc(meta.time)} s` : " @ 最新时间"} · ${esc(meta.size)}</div>`;
    if (job.message) html += `<div style="margin-top:3px">${esc(job.message)}</div>`;
    if (image) {
      html += `<img class="job-img" data-job-img="${esc(image.url)}" src="${esc(image.url)}" alt="渲染结果">`;
      html += `<div class="job-hint">点击图片查看大图</div>`;
      if (range) html += `<div style="margin-top:6px">色标范围 ${fmtRange(range[0])} → ${fmtRange(range[1])}</div>`;
    }
    if (job.status === "error") {
      const detail = job.result && job.result.detail;
      const lines = Array.isArray(job.log) && job.log.length ? job.log : (Array.isArray(detail) ? detail : []);
      if (lines.length) html += `<pre>${esc(lines.slice(-14).join("\n"))}</pre>`;
    }
    box.innerHTML = html;
  }

  async function renderNow() {
    if (!state.detail || state.renderBusy) return;
    const field = el("renderField").value;
    if (!field) {
      toast("该算例还没有可渲染的字段。", "warn");
      return;
    }
    const time = el("renderTime").value;
    const component = VECTOR_FIELDS.has(field) ? el("renderComponent").value : "Magnitude";
    const colormap = el("renderColormap").value;
    const background = el("renderBg").value === "dark";
    const size = el("renderSize").value.split("x").map(Number);
    const params = {
      field,
      time: time || "latest",
      component,
      colormap,
      background,
      width: size[0] || 1600,
      height: size[1] || 900,
    };
    const meta = {
      fieldLabel: `${fieldLabel(field)}${time ? ` / ${component}` : ""}`,
      time: time || "",
      size: `${params.width} × ${params.height}`,
    };
    const button = el("renderBtn");
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span><span>渲染中…</span>';
    state.renderBusy = true;
    el("renderJobBox").hidden = false;
    el("renderJobBox").className = "jobbox";
    el("renderJobBox").innerHTML = `<div class="job-title"><span class="spinner" style="width:13px;height:13px"></span><span>正在排队渲染…</span></div><div>${esc(meta.fieldLabel)} · ${esc(meta.size)}</div>`;
    try {
      const created = await post("/api/job", { kind: "render", name: state.caseName, params });
      state.renderJob = { id: created.id, caseName: state.caseName, meta };
      await pollRenderJob(created.id, state.caseName, meta);
    } catch (err) {
      el("renderJobBox").className = "jobbox error";
      el("renderJobBox").innerHTML = `<div class="job-title">渲染失败</div><div>${esc(errorText(err)).replace(/\n/g, "<br>")}</div>`;
      toast(errorText(err), "error", "渲染失败");
    } finally {
      state.renderBusy = false;
      button.disabled = false;
      button.innerHTML = '<svg class="ic"><use href="#i-camera"/></svg><span>生成当前帧</span>';
    }
  }

  async function pollRenderJob(id, caseName, meta) {
    while (state.renderJob && state.renderJob.id === id && state.caseName === caseName) {
      let job;
      try {
        job = await api(`/api/job?id=${enc(id)}`);
      } catch (err) {
        el("renderJobBox").className = "jobbox error";
        el("renderJobBox").innerHTML = `<div class="job-title">渲染失败</div><div>${esc(errorText(err))}</div>`;
        return;
      }
      if (!state.renderJob || state.renderJob.id !== id || state.caseName !== caseName) return;
      renderJobBox(job, meta);
      if (job.status === "done") {
        toast("云图已生成并加入结果画廊。", "ok", "渲染完成");
        await refreshDetail({ silent: true });
        return;
      }
      if (job.status === "error") {
        toast(job.message || "ParaView 渲染失败", "error", "渲染失败");
        return;
      }
      await sleep(1400);
    }
  }

  // ------------------------------------------------------------------ //
  // 力系数与网格
  // ------------------------------------------------------------------ //

  async function loadForces(datasetId, options = {}) {
    if (!state.caseName) return;
    const silent = Boolean(options.silent);
    const name = state.caseName;
    try {
      const extra = datasetId ? `&dataset=${enc(datasetId)}` : "";
      const result = await api(`/api/forces?${caseQuery(extra)}`);
      if (state.caseName !== name) return;
      state.forces = result;
      state.forcesFor = name;
      renderForceUI();
      if (state.tab === "data") requestAnimationFrame(drawForceChart);
    } catch (err) {
      if (state.caseName !== name) return;
      if (err.status === 404) {
        state.forces = { available: false, datasets: [], data: null };
        state.forcesFor = name;
        renderForceUI();
      } else if (!silent) {
        toast(errorText(err), "error", "力系数载入失败");
      }
    }
  }

  function renderForceUI() {
    const select = el("forceSelect");
    const available = state.forces && state.forces.available;
    const data = available ? state.forces.data : null;
    const datasets = state.forces && state.forces.datasets ? state.forces.datasets : [];
    if (!datasets.length) {
      select.innerHTML = '<option value="">无数据集</option>';
    } else {
      select.innerHTML = datasets.map((item) => `<option value="${esc(item.id)}">${esc(item.id)}</option>`).join("");
      if (data) select.value = data.id;
    }
    el("arefBadge").textContent = data && data.Aref !== null && data.Aref !== undefined ? `Aref = ${fmtNum(data.Aref, 4)}` : "Aref —";
    if (!data) {
      el("forceStats").innerHTML = "";
      el("forceHint").textContent = "该算例还没有力系数数据。若 system/controlDict 中启用了 forceCoeffs，运行后会在这里显示 Cd / Cl 曲线。";
      drawForceChart();
      renderForceMini();
      return;
    }
    const stats = data.stats || {};
    el("forceStats").innerHTML = [
      ["平均 Cd", fmtNum(stats.cdMean, 4), `${fmtNum(stats.cdMin, 3)} → ${fmtNum(stats.cdMax, 3)}`],
      ["Cl 振幅", fmtNum(stats.clAmp, 4), `${fmtNum(stats.clMin, 3)} → ${fmtNum(stats.clMax, 3)}`],
      ["振荡周期", stats.period ? `${fmtNum(stats.period, 3)} s` : "—", stats.cycles ? `${stats.cycles} 个周期` : "样本不足"],
      ["时间范围", `${fmtNum(stats.tMin, 3)} → ${fmtNum(stats.tMax, 3)} s`, "forceCoeffs"],
      ["数据点", fmtInt(stats.n), data.rows !== stats.n ? `文件 ${fmtInt(data.rows)} 行` : "全部采样"],
      ["参考面积", fmtNum(data.Aref, 4), "Aref"],
    ].map(([label, value, sub]) => `<div class="stat"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(sub || "")}</small></div>`).join("");
    const columns = Array.isArray(data.columns) ? data.columns.join(", ") : "Time, Cd, Cl";
    el("forceHint").textContent = `数据源 ${data.id} · 列 ${columns} · 更新 ${data.mtime || "—"}。Cd 使用左侧坐标轴，Cl 使用右侧坐标轴。`;
    drawForceChart();
    renderForceMini();
  }

  function drawForceChart() {
    const canvas = el("forceChart");
    if (!canvas || !canvas.offsetParent) return;
    const { ctx, width, height } = fitCanvas(canvas);
    const data = state.forces && state.forces.available ? state.forces.data : null;
    if (!data || !data.sample || !Array.isArray(data.sample.t) || data.sample.t.length < 2) {
      drawEmptyChart(ctx, width, height, "暂无力系数数据");
      return;
    }
    const sample = data.sample;
    const times = sample.t;
    const cds = sample.cd;
    const cls = sample.cl;
    const n = Math.min(times.length, cds.length, cls.length);
    if (n < 2) {
      drawEmptyChart(ctx, width, height, "力系数样本不足");
      return;
    }
    const t0 = times[0];
    const t1 = times[n - 1];
    let cdMin = Infinity, cdMax = -Infinity, clMin = Infinity, clMax = -Infinity;
    for (let i = 0; i < n; i += 1) {
      cdMin = Math.min(cdMin, cds[i]); cdMax = Math.max(cdMax, cds[i]);
      clMin = Math.min(clMin, cls[i]); clMax = Math.max(clMax, cls[i]);
    }
    const padCd = Math.max(0.05, (cdMax - cdMin) * 0.15);
    const padCl = Math.max(0.02, (clMax - clMin) * 0.15);
    cdMin -= padCd; cdMax += padCd; clMin -= padCl; clMax += padCl;
    const box = { left: 56, right: width - 60, top: 14, bottom: height - 30 };
    const xFor = (t) => box.left + ((t - t0) / Math.max(1e-12, t1 - t0)) * (box.right - box.left);
    const yCd = (value) => box.bottom - ((value - cdMin) / Math.max(1e-12, cdMax - cdMin)) * (box.bottom - box.top);
    const yCl = (value) => box.bottom - ((value - clMin) / Math.max(1e-12, clMax - clMin)) * (box.bottom - box.top);

    ctx.strokeStyle = COLORS.grid;
    ctx.font = chartFont(.66);
    ctx.textBaseline = "middle";
    const gridCount = 5;
    for (let i = 0; i <= gridCount; i += 1) {
      const y = box.top + ((box.bottom - box.top) * i) / gridCount;
      ctx.beginPath();
      ctx.moveTo(box.left, y + 0.5);
      ctx.lineTo(box.right, y + 0.5);
      ctx.stroke();
      const cdValue = cdMax - ((cdMax - cdMin) * i) / gridCount;
      const clValue = clMax - ((clMax - clMin) * i) / gridCount;
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(178,80,0,.9)";
      ctx.fillText(fmtNum(cdValue, 3), box.left - 8, y);
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(0,113,227,.9)";
      ctx.fillText(fmtNum(clValue, 3), box.right + 8, y);
    }
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.dim;
    for (let i = 0; i <= 4; i += 1) {
      const x = box.left + ((box.right - box.left) * i) / 4;
      ctx.fillText(fmtNum(t0 + ((t1 - t0) * i) / 4, 3), x, box.bottom + 16);
    }

    ctx.strokeStyle = COLORS.amber;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const x = xFor(times[i]);
      const y = yCd(cds[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.strokeStyle = COLORS.blue;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const x = xFor(times[i]);
      const y = yCl(cls[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.textAlign = "left";
    ctx.font = chartFont(.72);
    ctx.fillStyle = COLORS.amber;
    ctx.fillText("Cd", box.left + 8, box.top + 10);
    ctx.fillStyle = COLORS.blue;
    ctx.fillText("Cl", box.left + 40, box.top + 10);
  }

  function renderMeshBox(mesh) {
    const box = el("meshBox");
    const data = mesh || {};
    if (!data.checked) {
      box.innerHTML = `<p class="placeholder">还没有网格检查记录。运行 checkMesh 可以验证网格连通性与质量。</p>
        <div class="mesh-actions"><button class="btn primary small" data-act="checkmesh">运行网格检查</button></div>`;
      return;
    }
    const lines = state.meshCase === state.caseName && state.meshLines ? state.meshLines : null;
    box.innerHTML = `<div class="mesh-stats">
        <div class="stat"><span>网格单元</span><b>${fmtInt(data.cells)}</b><small>cells</small></div>
        <div class="stat"><span>网格节点</span><b>${fmtInt(data.points)}</b><small>points</small></div>
        <div class="stat"><span>网格面</span><b>${fmtInt(data.faces)}</b><small>faces</small></div>
        <div class="stat"><span>检查结果</span><b class="${data.ok ? "mesh-ok" : "mesh-bad"}">${data.ok ? "通过" : "有问题"}</b><small>${esc(data.log || "")}</small></div>
      </div>
      ${lines ? `<pre>${esc(lines.slice(-40).join("\n"))}</pre>` : `<p class="hint">日志 ${esc(data.log || "—")}${data.log_mtime ? ` · ${shortClock(data.log_mtime)}` : ""}</p>`}
      <div class="mesh-actions"><button class="btn ghost small" data-act="checkmesh">重新检查</button></div>`;
  }

  function meshJobHtml(job, serial) {
    if (!job || job.status === "queued" || job.status === "running") {
      return `<div class="job-status"><span class="spinner"></span><span>${esc((job && job.message) || "正在运行 checkMesh，请稍候…")}</span></div>
        <p class="modal-note">网格较大时可能需要几十秒。关闭窗口不会中止检查。</p>`;
    }
    if (job.status === "error") {
      const lines = Array.isArray(job.log) ? job.log : [];
      return `<div class="alert bad">${esc(job.message || "网格检查失败").replace(/\n/g, "<br>")}</div>
        ${lines.length ? `<pre class="job-log">${esc(lines.slice(-30).join("\n"))}</pre>` : ""}`;
    }
    const result = job.result || {};
    const mesh = result.mesh || {};
    const lines = Array.isArray(result.lines) ? result.lines : [];
    return `<div class="summary-grid">
        <div class="stat"><span>网格单元</span><b>${fmtInt(mesh.cells)}</b><small>cells</small></div>
        <div class="stat"><span>网格节点</span><b>${fmtInt(mesh.points)}</b><small>points</small></div>
        <div class="stat"><span>网格面</span><b>${fmtInt(mesh.faces)}</b><small>faces</small></div>
      </div>
      <div class="alert ${mesh.ok ? "" : "bad"}">${mesh.ok ? "网格检查通过（Mesh OK）。" : "网格检查发现问题，请查看日志。"}</div>
      <pre class="job-log">${esc(lines.slice(-60).join("\n"))}</pre>`;
  }

  async function runMeshCheck() {
    if (!state.caseName) return;
    if (state.progress && (state.progress.state === "running" || state.progress.state === "stopping")) {
      toast("求解正在运行，停止后再执行网格检查。", "warn");
      return;
    }
    const serial = openModal(`<div class="modal-head">
        <div><h3>网格检查</h3><p>checkMesh · ${esc(state.caseName)}</p></div>
        <button class="modal-x" data-close aria-label="关闭"><svg class="ic"><use href="#i-close"/></svg></button>
      </div>
      <div class="modal-body" id="meshJobBody">${meshJobHtml(null, 0)}</div>
      <div class="modal-foot"><button class="btn ghost" data-close>关闭</button></div>`, { wide: true });
    const name = state.caseName;
    try {
      const created = await post("/api/job", { kind: "checkmesh", name });
      let job = null;
      while (serial === state.modalSerial) {
        job = await api(`/api/job?id=${enc(created.id)}`);
        if (serial !== state.modalSerial) break;
        const body = el("meshJobBody");
        if (body) body.innerHTML = meshJobHtml(job, serial);
        if (job.status === "done" || job.status === "error") break;
        await sleep(1300);
      }
      if (job && job.status === "done" && serial === state.modalSerial) {
        state.detail.mesh = job.result.mesh;
        state.meshLines = job.result.lines || [];
        state.meshCase = name;
        renderMeshBox(state.detail.mesh);
        renderHeader();
        toast(`网格检查完成：${job.result.mesh.ok ? "通过" : "发现问题"}`, job.result.mesh.ok ? "ok" : "warn");
      } else if (job && job.status === "error") {
        toast(job.message || "网格检查失败", "error");
      }
    } catch (err) {
      const body = el("meshJobBody");
      if (body && serial === state.modalSerial) body.innerHTML = alertHtml(err);
      toast(errorText(err), "error", "网格检查失败");
    }
  }

  // ------------------------------------------------------------------ //
  // 字典编辑
  // ------------------------------------------------------------------ //

  function renderDictList() {
    const list = el("dictList");
    const dicts = (state.detail && state.detail.dicts) || [];
    if (!dicts.length) {
      list.innerHTML = '<div class="placeholder">没有可编辑的字典。</div>';
      return;
    }
    const groupNames = { system: "system（求解设置）", constant: "constant（物理参数）", "0": "0（初始场）" };
    const groups = {};
    dicts.forEach((item) => {
      if (!groups[item.group]) groups[item.group] = [];
      groups[item.group].push(item);
    });
    list.innerHTML = Object.keys(groups).map((group) => {
      const items = groups[group].map((item) => `<button class="dict-item${item.path === state.dictPath ? " active" : ""}" data-dict="${esc(item.path)}">
        <span>${esc(item.name)}</span><small>${fmtBytes(item.size)}</small>
      </button>`).join("");
      return `<div class="dict-group">${esc(groupNames[group] || group)}</div>${items}`;
    }).join("");
  }

  async function autoOpenDict() {
    const dicts = (state.detail && state.detail.dicts) || [];
    if (!dicts.length) return;
    const preferred = dicts.find((item) => item.path === "system/controlDict") || dicts[0];
    await openDict(preferred.path, { silent: true });
  }

  async function openDict(rel, options = {}) {
    if (!rel || !state.caseName) return;
    if (state.dictDirty && state.dictPath && state.dictPath !== rel && !options.force) {
      const ok = await confirmModal({
        title: "放弃未保存的修改？",
        body: `<p class="modal-note">${esc(state.dictPath)} 中有尚未保存的内容，切换文件会丢失这些修改。</p>`,
        okText: "放弃并切换",
        danger: true,
      });
      if (!ok) return;
    }
    const name = state.caseName;
    try {
      const result = await api(`/api/dict?${caseQuery(`&file=${enc(rel)}`)}`);
      if (state.caseName !== name) return;
      state.dictPath = result.path;
      state.dictSavedText = result.text;
      state.dictDirty = false;
      const textarea = el("dictText");
      textarea.value = result.text;
      textarea.classList.remove("dirty");
      el("dictPath").textContent = result.path;
      el("dictStatus").textContent = `${fmtBytes(result.size)} · ${shortClock(result.mtime)}`;
      el("dictSave").disabled = true;
      renderDictList();
    } catch (err) {
      if (state.caseName !== name) return;
      toast(errorText(err), "error", "字典载入失败");
    }
  }

  function markDictDirty() {
    if (!state.dictPath) return;
    const dirty = el("dictText").value !== state.dictSavedText;
    state.dictDirty = dirty;
    el("dictText").classList.toggle("dirty", dirty);
    el("dictSave").disabled = !dirty;
    el("dictStatus").textContent = dirty ? "有未保存的修改" : "已与磁盘一致";
  }

  async function saveDict() {
    if (!state.caseName || !state.dictPath || !state.dictDirty) return;
    const button = el("dictSave");
    const text = el("dictText").value;
    button.disabled = true;
    button.textContent = "保存中…";
    try {
      const result = await post("/api/dict/save", { name: state.caseName, file: state.dictPath, text });
      state.dictSavedText = text;
      state.dictDirty = false;
      el("dictText").classList.remove("dirty");
      el("dictStatus").textContent = result.backup ? `已保存 · 备份 ${result.backup}` : "已保存";
      toast(result.message || "已保存", "ok", "字典已保存");
      renderDictList();
    } catch (err) {
      toast(errorText(err), "error", "字典保存失败");
    } finally {
      button.textContent = "保存";
      button.disabled = !state.dictDirty;
    }
  }

  // ------------------------------------------------------------------ //
  // 启动 / 停止 / 复制 / 外部程序
  // ------------------------------------------------------------------ //

  function rankOptions() {
    const cores = Number(state.env && state.env.cores) || 32;
    const processors = state.detail ? state.detail.processorDirs || 0 : 0;
    if (processors > 0) return [processors];
    const values = [1, 2, 4, 6, 8, 12, 16, 24, 32, cores].filter((n) => n >= 1 && n <= cores);
    return Array.from(new Set(values)).sort((a, b) => a - b);
  }

  function openStartModal() {
    if (!state.detail) return;
    const d = state.detail;
    const c = d.control || {};
    const processors = d.processorDirs || 0;
    const ranks = rankOptions();
    const defaultRank = processors || 1;
    const startFrom = c.startFrom || "latestTime";
    const endTime = c.endTimeNum !== null && c.endTimeNum !== undefined ? `${fmtNum(c.endTimeNum, 6)} s` : "未设置";
    const latest = state.progress && state.progress.time !== null && state.progress.time !== undefined ? state.progress.time : d.latest;
    const cards = [
      ["latestTime", "从最新时间继续", latest !== null && latest !== undefined ? `当前最新写盘时间 t = ${fmtNum(latest, 6)} s` : "尚无可继续的时间，将退回起始时间"],
      ["startTime", "从起始时间开始", `controlDict startTime = ${fmtNum(c.startTimeNum, 6)} s`],
      ["firstTime", "从最早时间开始", "根目录中最早写出的时间（通常为 0 s）"],
    ].map(([value, title, desc]) => `<label class="radio-card">
        <input type="radio" name="startFromOption" value="${value}"${value === startFrom ? " checked" : ""}>
        <div><b>${title}</b><span>${desc}</span></div>
      </label>`).join("");
    openModal(`<div class="modal-head">
        <div><h3>启动计算</h3><p>${esc(d.name)} · ${esc(d.solver || "foamRun")} · 结束时间 ${esc(endTime)}</p></div>
        <button class="modal-x" data-close aria-label="关闭"><svg class="ic"><use href="#i-close"/></svg></button>
      </div>
      <div class="modal-body">
        <div class="field"><span>起始方式</span><div class="radio-stack">${cards}</div></div>
        <div class="two">
          <label class="field">并行核数
            <select id="startRanks">${ranks.map((n) => `<option value="${n}"${n === defaultRank ? " selected" : ""}>${n} 核${n === 1 ? "（串行）" : ""}</option>`).join("")}</select>
          </label>
          <label class="field">结束时间
            <input type="text" value="${esc(endTime)}" readonly>
          </label>
        </div>
        ${processors > 0 ? `<p class="modal-note">该算例已有 ${processors} 个 processor 目录，只能按 ${processors} 核并行继续；如要改核数，请先删除 processor* 目录。</p>` : '<p class="modal-note">选择多于 1 核时，工作台会在需要时自动执行 decomposePar 并启动 mpirun。首次分解可能需要一些时间。</p>'}
        <div id="startAlert"></div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="startSubmit"><svg class="ic"><use href="#i-play"/></svg><span>开始计算</span></button>
      </div>`);
    const submit = el("startSubmit");
    submit.addEventListener("click", async () => {
      const chosen = $('input[name="startFromOption"]:checked');
      const from = chosen ? chosen.value : "latestTime";
      const rank = Number(el("startRanks").value) || 1;
      submit.disabled = true;
      submit.innerHTML = '<span class="spinner"></span><span>正在启动…</span>';
      try {
        const result = await post("/api/run", { name: state.caseName, ranks: rank, startFrom: from });
        closeModal();
        toast(result.message || "求解器已启动", "ok", "计算已启动");
        await sleep(900);
        await refreshDetail({ silent: true, includeForm: true });
        pollProgress();
      } catch (err) {
        const alert = el("startAlert");
        if (alert) alert.innerHTML = alertHtml(err);
        submit.disabled = false;
        submit.innerHTML = '<svg class="ic"><use href="#i-play"/></svg><span>开始计算</span>';
      }
    });
  }

  async function stopRun() {
    if (!state.caseName) return;
    const ok = await confirmModal({
      title: "停止当前计算？",
      body: `<p class="modal-note">工作台会向 ${esc(state.caseName)} 的求解器发送 SIGINT，让它正常收尾并写出当前时间。若 8 秒内未退出，会依次升级为 SIGTERM 和 SIGKILL。</p>`,
      okText: "停止计算",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await post("/api/stop", { name: state.caseName });
      toast(result.message || "已发送停止信号", "warn", "停止请求已发送");
      await sleep(700);
      await refreshDetail({ silent: true });
      pollProgress();
    } catch (err) {
      toast(errorText(err), "error", "停止失败");
    }
  }

  function suggestedCopyName() {
    const base = state.caseName || "case";
    const existing = new Set(state.cases.map((item) => item.name));
    let candidate = `${base}-copy`;
    let index = 2;
    while (existing.has(candidate)) {
      candidate = `${base}-copy${index}`;
      index += 1;
    }
    return candidate.slice(0, 64);
  }

  function openCopyModal() {
    if (!state.caseName) {
      toast("请先选择一个算例。", "warn");
      return;
    }
    const suggestion = suggestedCopyName();
    openModal(`<div class="modal-head">
        <div><h3>复制算例</h3><p>${esc(state.caseName)} · 保留网格与已算出的时间目录</p></div>
        <button class="modal-x" data-close aria-label="关闭"><svg class="ic"><use href="#i-close"/></svg></button>
      </div>
      <div class="modal-body">
        <label class="field">新算例名称
          <input type="text" id="copyName" value="${esc(suggestion)}" maxlength="64" autocomplete="off">
        </label>
        <p class="modal-note">名称只能包含英文字母、数字、点、下划线与短横线，且必须以字母或数字开头。</p>
        <div id="copyAlert"></div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" data-close>取消</button>
        <button class="btn primary" id="copySubmit">复制</button>
      </div>`);
    const input = el("copyName");
    input.focus();
    input.select();
    const submit = el("copySubmit");
    const go = async () => {
      const value = input.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
        el("copyAlert").innerHTML = '<div class="alert bad">名称不合法，请使用英文字母、数字、点、下划线或短横线。</div>';
        return;
      }
      submit.disabled = true;
      submit.textContent = "复制中…";
      try {
        const result = await post("/api/copy", { name: state.caseName, newName: value });
        closeModal();
        toast(result.message || `已复制为 ${value}`, "ok", "算例已复制");
        await loadState();
        await selectCase(value);
      } catch (err) {
        el("copyAlert").innerHTML = alertHtml(err);
        submit.disabled = false;
        submit.textContent = "复制";
      }
    };
    submit.addEventListener("click", go);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); go(); }
    });
  }

  async function openExternal(kind) {
    if (!state.caseName) return;
    try {
      if (kind === "folder") {
        const result = await post("/api/openfolder", { name: state.caseName });
        toast(result.message || "已请求打开算例文件夹", "ok", "打开文件夹");
      } else {
        const result = await post("/api/paraview", { name: state.caseName });
        toast(result.message || "ParaView 正在启动", "ok", "ParaView");
      }
    } catch (err) {
      toast(errorText(err), "error", kind === "folder" ? "打开文件夹失败" : "ParaView 启动失败");
    }
  }

  // ------------------------------------------------------------------ //
  // 弹窗
  // ------------------------------------------------------------------ //

  function openModal(html, options = {}) {
    state.modalSerial += 1;
    const root = el("modalRoot");
    root.hidden = false;
    const box = el("modalBox");
    box.className = `modal${options.wide ? " wide" : ""}`;
    box.innerHTML = html;
    state.modalOnClose = options.onClose || null;
    window.setTimeout(() => {
      const first = box.querySelector("input:not([type=radio]), select, textarea, .modal-x") || box.querySelector(".modal-x");
      if (first) first.focus();
    }, 40);
    return state.modalSerial;
  }

  function closeModal() {
    const root = el("modalRoot");
    if (root.hidden) return;
    root.hidden = true;
    state.modalSerial += 1;
    const callback = state.modalOnClose;
    state.modalOnClose = null;
    if (callback) callback();
  }

  function confirmModal({ title, body, okText = "确认", danger = false }) {
    return new Promise((resolve) => {
      openModal(`<div class="modal-head">
          <div><h3>${esc(title)}</h3></div>
          <button class="modal-x" data-close aria-label="关闭"><svg class="ic"><use href="#i-close"/></svg></button>
        </div>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">
          <button class="btn ghost" data-close>取消</button>
          <button class="btn ${danger ? "danger" : "primary"}" id="modalOk">${esc(okText)}</button>
        </div>`);
      state.modalOnClose = () => resolve(false);
      const ok = el("modalOk");
      ok.addEventListener("click", () => {
        state.modalOnClose = null;
        closeModal();
        resolve(true);
      });
    });
  }

  // ------------------------------------------------------------------ //
  // 标签页与事件
  // ------------------------------------------------------------------ //

  function redrawCharts() {
    if (!state.detail) return;
    if (state.tab === "monitor") drawResidualChart(state.progress);
    if (state.tab === "data") drawForceChart();
  }

  function setTab(tab, options = {}) {
    const valid = ["overview", "monitor", "render", "data", "dict"];
    state.tab = valid.includes(tab) ? tab : "overview";
    localStorage.setItem("ofwb.tab", state.tab);
    $$("#tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === state.tab));
    $$(".tab").forEach((section) => { section.hidden = section.id !== `tab-${state.tab}`; });
    if (state.tab === "monitor" && state.detail) {
      if (!state.logLines) loadLog({ silent: true });
      requestAnimationFrame(() => drawResidualChart(state.progress));
    }
    if (state.tab === "data" && state.detail) {
      loadForces(state.forces && state.forces.data ? state.forces.data.id : null, { silent: true });
    }
    if (state.tab === "render" && state.detail) {
      if (!el("renderField").options.length) fillRenderFields();
      renderGallery();
    }
    if (state.tab === "dict" && state.detail && !state.dictPath) autoOpenDict();
    if (!options.initial) {
      el("main").scrollTop = 0;
    }
  }

  function bindEvents() {
    el("caseSearch").addEventListener("input", renderCases);
    el("caseList").addEventListener("click", (event) => {
      const item = event.target.closest("[data-case]");
      if (item) selectCase(item.dataset.case);
    });
    el("copyCaseBtn").addEventListener("click", openCopyModal);
    el("fontMinus").addEventListener("click", () => stepFont(-1));
    el("fontPlus").addEventListener("click", () => stepFont(1));
    el("refreshBtn").addEventListener("click", async () => {
      el("refreshBtn").disabled = true;
      await loadState();
      if (state.caseName) {
        await refreshDetail({ silent: true });
        await pollProgress();
      }
      el("refreshBtn").disabled = false;
      toast("界面数据已刷新。", "ok");
    });

    el("runBtn").addEventListener("click", openStartModal);
    el("stopBtn").addEventListener("click", stopRun);
    el("meshBtn").addEventListener("click", runMeshCheck);
    el("moreBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      el("moreMenu").hidden = !el("moreMenu").hidden;
    });

    el("tabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (button) setTab(button.dataset.tab);
    });

    el("paramForm").addEventListener("submit", saveParams);
    el("logSelect").addEventListener("change", () => {
      state.logFile = null;
      loadLog({ force: true });
    });
    el("logRefresh").addEventListener("click", () => loadLog({ force: true }));
    el("logFilter").addEventListener("input", renderLog);

    el("renderField").addEventListener("change", () => {
      updateRenderComponents(true);
      fillRenderTimes();
    });
    el("renderColormap").addEventListener("change", updateLutPreview);
    el("renderBtn").addEventListener("click", renderNow);
    el("galleryRefresh").addEventListener("click", async () => {
      await refreshDetail({ silent: true });
      toast("结果画廊已刷新。", "ok");
    });
    el("forceSelect").addEventListener("change", () => loadForces(el("forceSelect").value));

    el("dictList").addEventListener("click", (event) => {
      const item = event.target.closest("[data-dict]");
      if (item) openDict(item.dataset.dict);
    });
    el("dictReload").addEventListener("click", async () => {
      if (!state.dictPath) return;
      if (state.dictDirty) {
        const ok = await confirmModal({
          title: "重新载入字典？",
          body: `<p class="modal-note">${esc(state.dictPath)} 中未保存的修改会丢失。</p>`,
          okText: "重新载入",
          danger: true,
        });
        if (!ok) return;
      }
      await openDict(state.dictPath, { force: true });
    });
    el("dictSave").addEventListener("click", saveDict);
    el("dictText").addEventListener("input", markDictDirty);

    el("modalRoot").addEventListener("click", (event) => {
      if (event.target.closest("[data-close]")) closeModal();
    });
    el("lightClose").addEventListener("click", closeLightbox);
    el("lightbox").addEventListener("click", (event) => {
      if (event.target === el("lightbox")) closeLightbox();
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".menu-wrap")) el("moreMenu").hidden = true;
      const action = event.target.closest("[data-act]");
      if (action) {
        const kind = action.dataset.act;
        el("moreMenu").hidden = true;
        if (kind === "folder") openExternal("folder");
        else if (kind === "paraview") openExternal("paraview");
        else if (kind === "copy") openCopyModal();
        else if (kind === "checkmesh") runMeshCheck();
      }
      const go = event.target.closest("[data-goto]");
      if (go) setTab(go.dataset.goto);
      const thumb = event.target.closest("[data-img]");
      if (thumb) {
        const images = (state.detail && state.detail.images) || [];
        const image = images[Number(thumb.dataset.img)];
        if (image) openLightbox(image);
      }
      const jobImage = event.target.closest("[data-job-img]");
      if (jobImage) {
        openLightbox({ name: "最新渲染结果", url: jobImage.dataset.jobImg, size: 0, mtime: "" });
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (!el("lightbox").hidden) closeLightbox();
        else if (!el("modalRoot").hidden) closeModal();
        else el("moreMenu").hidden = true;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (state.tab === "dict" && state.dictPath) {
          event.preventDefault();
          saveDict();
        }
      }
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(redrawCharts, 180);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollProgress();
    });
  }

  // ------------------------------------------------------------------ //
  // 启动
  // ------------------------------------------------------------------ //

  function init() {
    let storedFont = Number(localStorage.getItem("ofwb.font"));
    if (!Number.isFinite(storedFont) || storedFont < 13 || storedFont > 24) storedFont = FONT_BASE;
    applyFont(storedFont, false);
    updateLutPreview();
    bindEvents();
    const storedTab = localStorage.getItem("ofwb.tab");
    setTab(storedTab || "overview", { initial: true });
    loadState();
    window.setInterval(loadState, 10000);
    window.setInterval(pollProgress, 2000);
    window.setInterval(() => {
      if (state.tab === "monitor" && state.detail && !document.hidden) loadLog({ silent: true });
    }, 3500);
  }

  init();
})();
