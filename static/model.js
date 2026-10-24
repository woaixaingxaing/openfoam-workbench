/* OpenFOAM 工作台 — Flow-3D 风格模型设置前端
 * 纯原生 JavaScript，无外部依赖。所有文案为简体中文。
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const enc = encodeURIComponent;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const SECTIONS = {
    general: { title: "通用", sub: "算例与时间控制", icon: "i-general" },
    physics: { title: "物理模型", sub: "层流 / 湍流与重力", icon: "i-physics" },
    fluid: { title: "流体属性", sub: "黏度、密度与物性", icon: "i-fluid" },
    mesh: { title: "网格", sub: "blockMesh 与网格检查", icon: "i-mesh" },
    initial: { title: "初始条件", sub: "0/ 目录的体积场", icon: "i-initial" },
    boundary: { title: "边界条件", sub: "各边界的场类型与数值", icon: "i-boundary" },
    numerics: { title: "数值方法", sub: "离散格式与线性求解器", icon: "i-numerics" },
    output: { title: "输出控制", sub: "写出频率、格式与力系数", icon: "i-output" },
    dict: { title: "高级字典", sub: "直接编辑 OpenFOAM 字典", icon: "i-dict" },
  };

  const TREE_GROUPS = [
    ["模型", ["general", "physics", "fluid", "mesh"]],
    ["条件", ["initial", "boundary"]],
    ["求解", ["numerics", "output"]],
    ["高级", ["dict"]],
  ];

  const TREE_TAGS = {
    general: "controlDict", physics: "momentum", fluid: "physical", mesh: "blockMesh",
    initial: "0/", boundary: "boundaryField", numerics: "fvSchemes", output: "controlDict", dict: "字典",
  };

  const CASE_STATE = {
    running: { label: "计算中", cls: "running" },
    stopping: { label: "停止中", cls: "running" },
    completed: { label: "已完成", cls: "done" },
    stopped: { label: "已中断", cls: "error" },
    error: { label: "出错", cls: "error" },
    ready: { label: "就绪", cls: "" },
  };

  const NO_VALUE_BC = new Set([
    "zeroGradient", "slip", "noSlip", "empty", "symmetry", "symmetryPlane", "wedge",
    "cyclic", "cyclicAMI", "processor", "processorCyclic", "calculated",
    "fixedFluxPressure", "fixedGradient", "uniformFixedValue",
  ]);
  const VALUE_BC = [
    "fixedValue", "noSlip", "slip", "zeroGradient", "empty", "symmetry", "symmetryPlane",
    "inletOutlet", "outletInlet", "pressureInletOutletVelocity", "pressureInletUniformVelocity",
    "flowRateInletVelocity", "surfaceNormalFixedValue", "movingWallVelocity", "rotatingWallVelocity",
    "translatingWallVelocity", "totalPressure", "totalTemperature", "uniformTotalPressure",
    "advective", "waveTransmissive", "timeVaryingMappedFixedValue", "uniformInletOutlet",
    "kqRWallFunction", "epsilonWallFunction", "omegaWallFunction", "nutkWallFunction",
    "nutUWallFunction", "nutUSpaldingWallFunction", "nutLowReWallFunction", "alphatWallFunction",
    "externalWallHeatFluxTemperature", "fixedGradient", "fixedFluxPressure", "uniformFixedValue",
  ];

  const S = {
    cases: [], env: null, name: "", model: null, detail: null,
    section: localStorage.getItem("ofm.section") || "general",
    dirty: false, busy: false, pollTimer: null, wasRunning: false,
    meshLog: "", meshLogTitle: "",
    templates: null,
    dictFile: localStorage.getItem("ofm.dict") || "system/controlDict",
    dictText: "", dictLoadedFor: "", dictDirty: false,
    boundaryField: "", boundaryExtras: {},
    selectedPatch: "", selectedFieldPatch: "",
    view: { yaw: -0.82, pitch: 0.42, dist: 1.65, auto: true, faces: [], hover: "" },
    canvas: { W: 0, H: 0, dpr: 1 },
    drag: null,
  };

  // ------------------------------------------------------------------ //
  // 工具
  // ------------------------------------------------------------------ //

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function fmtNum(value, digits = 8) {
    if (value === null || value === undefined || value === "") return "";
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (n === 0) return "0";
    if (Math.abs(n) >= 1e-4 && Math.abs(n) < 1e6) {
      return String(Number(n.toPrecision(digits)));
    }
    return n.toExponential(4).replace("e+", "e");
  }

  function parseNumbers(text) {
    return (String(text ?? "").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  }

  function parseVec(text) {
    const nums = parseNumbers(text);
    return nums.length >= 3 ? nums.slice(0, 3) : null;
  }

  function parseScalar(text) {
    const nums = parseNumbers(text);
    return nums.length ? nums[0] : null;
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function hexRgba(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function field(label, control, hint = "") {
    return `<div class="field"><label>${label}</label>${control}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
  }

  function input(id, value, attrs = "") {
    return `<input id="${id}" value="${esc(fmtNum(value))}" ${attrs}>`;
  }

  function select(id, options, value, attrs = "") {
    const list = options.map((item) => {
      const val = typeof item === "string" ? item : item.value;
      const label = typeof item === "string" ? item : item.label;
      return `<option value="${esc(val)}"${String(val) === String(value) ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
    return `<select id="${id}" ${attrs}>${list}</select>`;
  }

  function vecInputs(prefix, vec, labels = ["X", "Y", "Z"]) {
    const v = Array.isArray(vec) ? vec : [0, 0, 0];
    return `<div class="grid-3">${labels.map((label, i) =>
      field(label, `<input id="${prefix}-${i}" type="number" step="any" value="${esc(fmtNum(v[i]))}">`)
    ).join("")}</div>`;
  }

  function toast(message, type = "ok", title = "") {
    const root = $("toasts");
    if (!root) return;
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.innerHTML = `${title ? `<b>${esc(title)}</b>` : ""}${esc(message)}`;
    root.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  function setStatus(text, kind = "") {
    const dot = $("statusDot");
    if (dot) dot.className = `status-dot ${kind}`;
    if ($("statusText")) $("statusText").textContent = text;
  }

  function setBusy(flag, text = "") {
    S.busy = flag;
    if (flag) setStatus(text || "处理中…", "busy");
    else setStatus(S.model ? "就绪" : "等待选择算例", "ok");
    updateButtons();
  }

  function updateButtons() {
    const has = !!S.model;
    const running = !!(S.model && S.model.run && S.model.run.running);
    if ($("saveBtn")) $("saveBtn").disabled = !has || S.busy;
    if ($("applyBtn")) $("applyBtn").disabled = !has || !S.dirty || S.busy;
    if ($("blockMeshBtn")) $("blockMeshBtn").disabled = !has || S.busy;
    if ($("checkMeshBtn")) $("checkMeshBtn").disabled = !has || S.busy;
    if ($("preflightBtn")) $("preflightBtn").disabled = !has || S.busy;
    if ($("runBtn")) $("runBtn").disabled = !has || running || S.busy;
    if ($("stopBtn")) $("stopBtn").disabled = !has || !running;
    if ($("paraviewBtn")) $("paraviewBtn").disabled = !has || S.busy;
    if ($("folderBtn")) $("folderBtn").disabled = !has || S.busy;
    updateHealth();
  }

  function markDirty() {
    if (!S.model) return;
    S.dirty = true;
    if ($("dirtyBadge")) $("dirtyBadge").hidden = false;
    if ($("applyBtn")) $("applyBtn").disabled = S.busy;
    updateHealth();
  }

  function clearDirty() {
    S.dirty = false;
    if ($("dirtyBadge")) $("dirtyBadge").hidden = true;
    if ($("applyBtn")) $("applyBtn").disabled = true;
    updateHealth();
  }

  function errorText(err) {
    let text = err && err.message ? err.message : String(err);
    if (err && err.detail) {
      const detail = Array.isArray(err.detail) ? err.detail.join("\n") : String(err.detail);
      if (detail.trim()) text += `\n\n${detail.trim()}`;
    }
    return text;
  }

  // ------------------------------------------------------------------ //
  // HTTP
  // ------------------------------------------------------------------ //

  async function api(path, options = {}) {
    const res = await fetch(path, { cache: "no-store", ...options });
    let data = null;
    try { data = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
      err.detail = data && data.detail;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  // ------------------------------------------------------------------ //
  // 弹窗
  // ------------------------------------------------------------------ //

  function showModal(html, options = {}) {
    const root = $("modalRoot");
    const box = $("modalBox");
    if (!root || !box) return { box: null, close: () => {} };
    box.className = `modal${options.wide ? " wide" : ""}`;
    box.innerHTML = html;
    root.hidden = false;
    const close = () => {
      root.hidden = true;
      box.innerHTML = "";
    };
    $$("[data-close]", root).forEach((btn) => btn.addEventListener("click", close));
    return { box, close };
  }

  function confirmDialog({ title, sub = "", body = "", okText = "确定", cancelText = "取消", danger = false }) {
    return new Promise((resolve) => {
      const { box, close } = showModal(`
        <h2>${esc(title)}</h2>
        ${sub ? `<div class="modal-sub">${esc(sub)}</div>` : ""}
        ${body ? `<div class="modal-note">${body}</div>` : ""}
        <div class="modal-actions">
          <button class="btn-cancel" id="mCancel">${esc(cancelText)}</button>
          <button class="${danger ? "btn-danger" : "btn-ok"}" id="mOk">${esc(okText)}</button>
        </div>`);
      if (!box) { resolve(false); return; }
      box.querySelector("#mCancel").addEventListener("click", () => { close(); resolve(false); });
      box.querySelector("#mOk").addEventListener("click", () => { close(); resolve(true); });
    });
  }

  function showError(err) {
    const text = errorText(err);
    const { box, close } = showModal(`
      <h2>操作未完成</h2>
      <div class="modal-sub">请根据下面的信息修正后重试。</div>
      <div class="alert bad" style="white-space:pre-wrap;max-height:320px;overflow:auto">${esc(text)}</div>
      <div class="modal-actions"><button class="btn-ok" id="errOk">知道了</button></div>`, { wide: true });
    if (box) box.querySelector("#errOk").addEventListener("click", close);
  }

  function askUnsaved() {
    return new Promise((resolve) => {
      const { box, close } = showModal(`
        <h2>当前设置尚未保存</h2>
        <div class="modal-sub">切换分区或算例前，要保存这次修改吗？</div>
        <div class="modal-note">选择“放弃修改”会丢失右侧面板中尚未应用的输入。</div>
        <div class="modal-actions">
          <button class="btn-cancel" id="uCancel">取消</button>
          <button class="btn-cancel" id="uDiscard">放弃修改</button>
          <button class="btn-ok" id="uSave">保存并继续</button>
        </div>`);
      if (!box) { resolve("discard"); return; }
      box.querySelector("#uCancel").addEventListener("click", () => { close(); resolve("cancel"); });
      box.querySelector("#uDiscard").addEventListener("click", () => { close(); resolve("discard"); });
      box.querySelector("#uSave").addEventListener("click", () => { close(); resolve("save"); });
    });
  }

  // ------------------------------------------------------------------ //
  // 设置体检：把启动前最容易踩的坑集中成一次检查
  // ------------------------------------------------------------------ //

  const LEVEL_META = {
    error: { label: "需要处理", icon: "i-warning", cls: "error" },
    warn: { label: "建议确认", icon: "i-warning", cls: "warn" },
    info: { label: "提示", icon: "i-info", cls: "info" },
    ok: { label: "通过", icon: "i-check", cls: "ok" },
  };

  function buildChecks() {
    const checks = [];
    const add = (level, title, detail, fix = null) => checks.push({ level, title, detail, fix });
    if (!S.model) {
      add("error", "没有选择算例", "在顶部选择一个算例，或先新建算例。");
      return checks;
    }
    const c = S.model.control || {};
    const mesh = S.model.mesh || {};
    const phys = S.model.physics || {};
    const fields = (S.model.fields && S.model.fields.list) || {};
    const names = Object.keys(fields);
    const detail = S.detail || {};
    const caseInfo = caseByName(S.name) || {};
    const running = !!(S.model.run && S.model.run.running) || !!caseInfo.running;

    // 场文件
    if (!names.length) {
      add("error", "0/ 目录没有场文件", "没有 U、p 等初始场，求解器无法启动。可切换到“初始条件”查看。", { section: "initial" });
    } else {
      const missing = [];
      if (!fields.U) missing.push("U");
      if (!fields.p && !fields.p_rgh) missing.push("p");
      if (missing.length) {
        add("error", `缺少必要的场：${missing.join("、")}`, "不可压缩求解器至少需要 U 和 p。请检查 0/ 目录或高级字典。", { section: "initial" });
      } else {
        add("ok", `已找到 ${names.length} 个场`, names.join("、"), { section: "initial" });
      }
    }

    // 网格
    const hasMesh = !!mesh.hasPolyMesh || mesh.polyCells > 0;
    if (!hasMesh) {
      if (mesh.blockMeshFile) {
        add("error", "还没有生成网格", "blockMeshDict 已存在，但 constant/polyMesh 尚未生成。先运行 blockMesh。", { action: "blockmesh" });
      } else {
        add("error", "没有可用网格", "没有 blockMeshDict 也没有 polyMesh。请配置网格，或从模板新建算例。", { section: "dict", file: "system/blockMeshDict" });
      }
    } else {
      const cells = mesh.polyCells || mesh.cellTotal;
      add("ok", `网格已就绪：${cells != null ? Number(cells).toLocaleString("zh-CN") : "—"} 个单元`,
        mesh.blockCount > 1 ? `blockMesh 共 ${mesh.blockCount} 块` : "单块 blockMesh");
    }

    // checkMesh
    const meshCheck = detail.mesh || {};
    if (meshCheck.checked) {
      if (meshCheck.ok) {
        add("ok", "checkMesh 已通过", meshCheck.cells != null ? `${Number(meshCheck.cells).toLocaleString("zh-CN")} 个单元通过质量检查` : "");
      } else {
        add("error", "checkMesh 未通过", "网格质量或连通性有问题，直接计算可能发散。请查看检查日志。", { action: "checkmesh" });
      }
    } else {
      add("info", "尚未运行 checkMesh", "运行一次网格检查可以提前发现负体积、非正交等问题。", { action: "checkmesh" });
    }

    if (mesh.blockCellTotal && mesh.polyCells && mesh.blockCellTotal !== mesh.polyCells) {
      add("warn", "blockMeshDict 与现有网格单元数不一致",
        `字典 ${Number(mesh.blockCellTotal).toLocaleString("zh-CN")}，polyMesh ${Number(mesh.polyCells).toLocaleString("zh-CN")}。修改尺寸后需要重新生成网格。`,
        { action: "blockmesh" });
    }

    // 时间控制
    const start = c.startTimeNum;
    const end = c.endTimeNum;
    const dt = c.deltaTNum;
    if (c.stopAt && c.stopAt !== "endTime") {
      add("warn", `停止方式为 ${c.stopAt}`, "界面进度按 endTime 估算；使用 writeNow 等模式时请自行确认。", { section: "general" });
    }
    if (!(end > start)) {
      add("error", "结束时间必须大于起始时间", `当前 ${fmtNum(start, 6)} → ${fmtNum(end, 6)} s，请调整时间控制。`, { section: "general" });
    } else if (!(dt > 0)) {
      add("error", "时间步长需要正数", `当前 deltaT = ${fmtNum(dt, 6)} s。`, { section: "general" });
    } else {
      const steps = Math.ceil((end - start) / dt);
      add("ok", "时间范围有效", `${fmtNum(start, 6)} → ${fmtNum(end, 6)} s · 固定步长约 ${steps.toLocaleString("zh-CN")} 步`, { section: "general" });
      if (dt > (end - start)) {
        add("warn", "时间步长大于计算总时长", "只会推进一个时间步，请确认是否符合预期。", { section: "general" });
      }
    }
    const adjust = String(c.adjustTimeStep || "").toLowerCase() === "yes";
    if (adjust && !(c.maxCoNum > 0)) {
      add("error", "自适应时间步缺少最大库朗数", "启用 adjustTimeStep 时必须设置正数 maxCo。", { section: "general" });
    }
    if (c.writeControl === "runTime") {
      const writeEvery = c.writeIntervalNum;
      if (!(writeEvery > 0)) {
        add("warn", "写出间隔不是正数", "writeControl=runTime 时 writeInterval 表示写出周期（秒）。", { section: "output" });
      } else if (end > start && writeEvery > (end - start)) {
        add("info", "计算过程中不会写出中间结果",
          `写出间隔 ${fmtNum(writeEvery, 6)} s 大于总时长；只在计算结束或手动写出时保存结果。`,
          { section: "output" });
      }
    }

    // 湍流场
    const sim = String(phys.simulationType || "laminar");
    if (sim === "RAS" || sim === "LES") {
      const missing = ["k", "nut"].filter((name) => !fields[name]);
      if (!fields.omega && !fields.epsilon) missing.push("omega 或 epsilon");
      if (missing.length) {
        add("error", `${sim} 缺少湍流场：${missing.join("、")}`, "湍流模型需要相应的 0/ 场文件，否则求解器启动时会报错。", { section: "physics" });
      } else {
        add("ok", `湍流模型 ${sim} 的场已齐全`, String(phys.model || phys.turbulence || "k、nut、omega/epsilon"), { section: "physics" });
      }
    } else if (fields.k || fields.omega || fields.epsilon) {
      add("info", "层流算例仍保留湍流场", "多余场不会被使用，但会让 0/ 目录显得杂乱；可以忽略。", { section: "physics" });
    }

    // 边界条件
    if (fields.U) {
      const selectors = (fields.U.patches || []).map((p) => p.name);
      const meshPatches = mesh.patches || [];
      const meshNames = new Set(meshPatches.map((p) => p.name));
      const exact = selectors.filter((name) => meshNames.has(name));
      const groupish = selectors.filter((name) => !meshNames.has(name));
      if (!selectors.length) {
        add("error", "U 没有边界条件", "boundaryField 为空，求解器无法确定入口、出口和壁面。", { section: "boundary", patch: meshPatches[0] && meshPatches[0].name });
      } else if (groupish.length && !exact.length) {
        add("warn", "U 的边界名称与网格不完全一致",
          `字段使用 ${selectors.join("、")}；网格为 ${meshPatches.map((p) => p.name).join("、")}。若使用 patchGroup 或 includeEtc 可忽略。`,
          { section: "boundary" });
      } else {
        add("ok", `U 已定义 ${selectors.length} 个边界条件`,
          selectors.slice(0, 6).join("、") + (selectors.length > 6 ? "…" : ""), { section: "boundary" });
      }
    }

    if (running) add("warn", "计算正在运行", "运行中的算例会锁定字典修改；停止后才能应用新设置。", { action: "stop" });
    if (S.dirty) add("warn", "有尚未应用的修改", "当前面板中的输入尚未写入字典。保存后再启动计算。", { action: "save" });
    if (S.meshLog && /(^|\n).*(fail|error)/i.test(S.meshLog.slice(-4000))) {
      add("warn", "最近一次网格操作日志包含错误", "请在“网格”分区查看日志末尾。", { section: "mesh" });
    }
    return checks;
  }

  function checkCounts(checks) {
    return {
      errors: checks.filter((item) => item.level === "error").length,
      warns: checks.filter((item) => item.level === "warn").length,
      infos: checks.filter((item) => item.level === "info").length,
      oks: checks.filter((item) => item.level === "ok").length,
    };
  }

  function updateHealth() {
    const btn = $("preflightBtn");
    const badge = $("healthBadge");
    if (!btn || !badge) return;
    btn.classList.remove("has-error", "has-warn", "is-ok");
    if (!S.model) {
      badge.textContent = "—";
      btn.title = "选择算例后运行设置体检";
      return;
    }
    const counts = checkCounts(buildChecks());
    if (counts.errors) {
      badge.textContent = String(counts.errors);
      btn.classList.add("has-error");
      btn.title = `${counts.errors} 项需要处理 · ${counts.warns} 项建议确认`;
    } else if (counts.warns) {
      badge.textContent = String(counts.warns);
      btn.classList.add("has-warn");
      btn.title = `${counts.warns} 项建议确认，没有阻塞错误`;
    } else {
      badge.textContent = "通过";
      btn.classList.add("is-ok");
      btn.title = "设置完整，可以启动计算";
    }
  }

  function fixText(item) {
    if (!item.fix) return "";
    return item.level === "info" ? "去处理" : "去修复";
  }

  async function openPreflight(options = {}) {
    if (!S.model) { toast("请先选择算例", "error"); return; }
    try { await ensureDetail(true); } catch (_) { /* 保留旧详情 */ }
    const checks = buildChecks();
    const counts = checkCounts(checks);
    const order = ["error", "warn", "info", "ok"];
    const groups = order.map((level) => ({
      level,
      meta: LEVEL_META[level],
      items: checks.filter((item) => item.level === level),
    })).filter((group) => group.items.length);
    const row = (item, index) => {
      const meta = LEVEL_META[item.level];
      return `<div class="check-row ${meta.cls}">
        <span class="check-mark"><svg class="ic"><use href="#${meta.icon}"/></svg></span>
        <div class="check-copy"><b>${esc(item.title)}</b>${item.detail ? `<span>${esc(item.detail)}</span>` : ""}</div>
        ${item.fix && item.level !== "ok" ? `<button class="check-fix" data-fix="${index}">${fixText(item)}</button>` : ""}
      </div>`;
    };
    const body = groups.map((group) => `
      <div class="check-group">
        <div class="check-group-head"><span class="check-count ${group.meta.cls}">${group.items.length}</span>${group.meta.label}</div>
        ${group.items.map((item) => row(item, checks.indexOf(item))).join("")}
      </div>`).join("");
    const summary = counts.errors
      ? `<div class="alert bad">有 ${counts.errors} 项会阻止计算，请先处理。${counts.warns ? ` 另有 ${counts.warns} 项建议确认。` : ""}</div>`
      : counts.warns
        ? `<div class="alert warn">没有阻塞错误，但有 ${counts.warns} 项建议确认。</div>`
        : `<div class="alert ok">设置完整，没有发现会阻止计算的问题。</div>`;
    const running = !!(S.model.run && S.model.run.running);
    const primary = counts.errors || running
      ? `<button class="btn-ok" id="checkAgain">重新检查</button>`
      : S.dirty
        ? `<button class="btn-ok" id="checkSaveRun">保存并启动</button>`
        : `<button class="btn-ok" id="checkRun">${options.fromRun ? "仍然启动" : "启动计算"}</button>`;
    const { box, close } = showModal(`
      <h2>设置体检</h2>
      <div class="modal-sub">${esc(S.name)} · 启动前把网格、时间、场文件和边界条件一次性核对</div>
      <div class="check-summary">
        <span class="sum error${counts.errors ? "" : " zero"}">${counts.errors}<small>需要处理</small></span>
        <span class="sum warn${counts.warns ? "" : " zero"}">${counts.warns}<small>建议确认</small></span>
        <span class="sum ok">${counts.oks}<small>通过</small></span>
        <span class="sum info">${counts.infos}<small>提示</small></span>
      </div>
      ${summary}
      <div class="check-body">${body || `<div class="check-empty">没有检查结果。</div>`}</div>
      <div class="modal-actions">
        <button class="btn-cancel" data-close>关闭</button>
        ${primary}
      </div>`, { wide: true });
    if (!box) return;
    box.querySelectorAll("[data-fix]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const item = checks[Number(btn.dataset.fix)];
        if (!item || !item.fix) return;
        close();
        await runFix(item.fix);
      });
    });
    const again = box.querySelector("#checkAgain");
    if (again) again.addEventListener("click", () => { close(); openPreflight(); });
    const start = box.querySelector("#checkRun");
    if (start) start.addEventListener("click", () => { close(); doRun({ skipPreflight: true }); });
    const saveRun = box.querySelector("#checkSaveRun");
    if (saveRun) saveRun.addEventListener("click", async () => {
      close();
      const ok = await saveSection();
      if (ok) doRun({ skipPreflight: true });
    });
  }

  async function runFix(fix) {
    if (!fix) return;
    if (fix.action === "blockmesh") return doBlockMesh();
    if (fix.action === "checkmesh") return doCheckMesh();
    if (fix.action === "save") return saveSection();
    if (fix.action === "stop") return doStop();
    if (fix.section === "boundary" && fix.patch) return focusPatch(fix.patch, { force: true });
    if (fix.section === "dict" && fix.file) S.dictFile = fix.file;
    if (fix.section) return switchSection(fix.section);
  }

  async function preflightGate() {
    try { await ensureDetail(true); } catch (_) { /* 使用现有详情 */ }
    const checks = buildChecks();
    const counts = checkCounts(checks);
    if (counts.errors) {
      toast(`有 ${counts.errors} 项设置需要先处理`, "error", "运行前检查");
      await openPreflight({ fromRun: true });
      return false;
    }
    if (counts.warns) {
      const warns = checks.filter((item) => item.level === "warn");
      const body = `<ul class="compact-list">${warns.map((item) => `<li><b>${esc(item.title)}</b>${item.detail ? `<span>${esc(item.detail)}</span>` : ""}</li>`).join("")}</ul>`;
      const ok = await confirmDialog({
        title: `有 ${counts.warns} 项建议确认`,
        sub: "这些不是阻塞错误，但可能让计算结果与预期不一致。",
        body,
        okText: "仍然启动",
        cancelText: "返回检查",
      });
      if (!ok) { await openPreflight({ fromRun: true }); return false; }
    }
    return true;
  }

  // ------------------------------------------------------------------ //
  // 3D 视图中的边界选择
  // ------------------------------------------------------------------ //

  function patchCardNameFor(fieldName, meshName) {
    const fields = (S.model && S.model.fields && S.model.fields.list) || {};
    const entries = (fields[fieldName] && fields[fieldName].patches) || [];
    if (entries.some((item) => item.name === meshName)) return meshName;
    const meshPatch = ((S.model.mesh && S.model.mesh.patches) || []).find((item) => item.name === meshName);
    if (meshPatch && meshPatch.type === "wall" && entries.some((item) => item.name === "wall")) return "wall";
    const group = entries.find((item) => item.name && /[|*]/.test(item.name));
    return group ? group.name : "";
  }

  function bestFieldForPatch(meshName) {
    const fields = (S.model && S.model.fields && S.model.fields.list) || {};
    const names = Object.keys(fields);
    if (fields.U && patchCardNameFor("U", meshName)) return "U";
    const match = names.find((name) => !!patchCardNameFor(name, meshName));
    return match || S.boundaryField || names[0] || "";
  }

  async function focusPatch(meshName, options = {}) {
    if (!meshName || !S.model) return;
    if (S.dirty && !options.force) {
      const choice = await askUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await saveSection();
        if (!ok) return;
      } else {
        clearDirty();
      }
    }
    S.selectedPatch = meshName;
    S.section = "boundary";
    S.boundaryField = bestFieldForPatch(meshName);
    S.selectedFieldPatch = patchCardNameFor(S.boundaryField, meshName);
    localStorage.setItem("ofm.section", "boundary");
    renderTree();
    renderProps();
    renderViewport();
    if (!S.selectedFieldPatch) {
      toast(`字段 ${S.boundaryField || "U"} 中没有与 ${meshName} 同名的边界，可能使用了 patchGroup`, "warn", "边界条件");
      return;
    }
    requestAnimationFrame(() => {
      const body = $("propsBody");
      if (!body) return;
      const card = Array.from(body.querySelectorAll("[data-bc-patch]"))
        .find((node) => node.dataset.bcPatch === S.selectedFieldPatch);
      if (!card) return;
      card.classList.add("just-focus");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => card.classList.remove("just-focus"), 1600);
    });
  }

  function pointInFace(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
      const xi = points[i].x;
      const yi = points[i].y;
      const xj = points[j].x;
      const yj = points[j].y;
      const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function pickPatch(event) {
    const faces = S.view.faces || [];
    const canvas = $("view");
    if (!canvas || !faces.length) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    for (let i = faces.length - 1; i >= 0; i -= 1) {
      const face = faces[i];
      if (face.points && face.points.length >= 3 && pointInFace(x, y, face.points)) return face;
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  // 算例加载与轮询
  // ------------------------------------------------------------------ //

  function renderCaseSelect() {
    const sel = $("caseSelect");
    if (!sel) return;
    if (!S.cases.length) {
      sel.innerHTML = `<option value="">没有算例</option>`;
      sel.value = "";
      return;
    }
    sel.innerHTML = S.cases.map((item) => {
      const state = CASE_STATE[item.state] || CASE_STATE.ready;
      return `<option value="${esc(item.name)}" title="${esc(state.label)} · ${esc(item.solver || "")}">${esc(item.name)}</option>`;
    }).join("");
    if (S.name && S.cases.some((item) => item.name === S.name)) sel.value = S.name;
    else if (!sel.value && S.cases.length) sel.value = S.cases[0].name;
  }

  function renderEnv(env) {
    S.env = env || null;
    if (!env) return;
    const bits = [];
    if (env.version) bits.push(`OpenFOAM ${env.version}`);
    if (env.cores) bits.push(`${env.cores} 核`);
    if (env.memAvail != null && env.memTotal != null) bits.push(`内存 ${env.memAvail}/${env.memTotal} GB`);
    setStatus(`已连接 · ${bits.join(" · ")}`, "ok");
  }

  async function loadState() {
    try {
      const data = await api("/api/state");
      S.cases = data.cases || [];
      renderCaseSelect();
      renderEnv(data.env);
      return true;
    } catch (err) {
      setStatus(`无法连接本地服务：${err.message}`, "bad");
      return false;
    }
  }

  function caseByName(name) {
    return S.cases.find((item) => item.name === name) || null;
  }

  async function selectCase(name, options = {}) {
    if (!name) return;
    if (!options.force && S.dirty) {
      const choice = await askUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await saveSection();
        if (!ok) return;
      } else {
        clearDirty();
      }
    }
    S.name = name;
    localStorage.setItem("ofm.case", name);
    try {
      const url = new URL(location.href);
      url.searchParams.set("case", name);
      history.replaceState(null, "", url);
    } catch (_) { /* ignore */ }
    if ($("caseSelect")) $("caseSelect").value = name;
    S.model = null;
    S.detail = null;
    S.dirty = false;
    S.dictText = "";
    S.dictLoadedFor = "";
    S.dictDirty = false;
    S.meshLog = "";
    S.meshLogTitle = "";
    S.boundaryField = "";
    S.boundaryExtras = {};
    S.selectedPatch = "";
    S.selectedFieldPatch = "";
    S.view.hover = "";
    S.view.faces = [];
    clearDirty();
    renderTree();
    renderViewport();
    if ($("propsBody")) $("propsBody").innerHTML = `<div class="empty-props">正在读取算例设置…</div>`;
    setStatus(`正在读取 ${name}…`, "busy");
    try {
      const model = await api(`/api/model?name=${enc(name)}`);
      if (S.name !== name) return;
      S.model = model;
      const fields = Object.keys((model.fields && model.fields.list) || {});
      S.boundaryField = fields[0] || "";
      renderTree();
      renderViewport();
      renderProps();
      updateRunBadge();
      updateButtons();
      setStatus(`就绪 · ${name}`, "ok");
      const warnings = model.warnings || [];
      if ($("statusWarn")) {
        $("statusWarn").textContent = warnings.length ? `${warnings.length} 条提示` : "";
        $("statusWarn").title = warnings.join("\n");
      }
      ensureDetail().catch(() => {});
      startPolling();
    } catch (err) {
      if (S.name !== name) return;
      setStatus(`读取失败：${err.message}`, "bad");
      showError(err);
    }
  }

  async function ensureDetail(force = false) {
    if (!S.name) return null;
    if (!force && S.detail && S.detail.name === S.name) return S.detail;
    const detail = await api(`/api/case?name=${enc(S.name)}`);
    if (S.name === detail.name) S.detail = detail;
    return detail;
  }

  async function refreshModel(options = {}) {
    if (!S.name) return null;
    try {
      const model = await api(`/api/model?name=${enc(S.name)}`);
      if (S.name !== model.name) return null;
      S.model = model;
      renderTree();
      renderViewport();
      if (!S.dirty || options.force) renderProps();
      updateRunBadge();
      updateButtons();
      return model;
    } catch (err) {
      if (!options.silent) toast(err.message, "error", "刷新失败");
      return null;
    }
  }

  function updateRunBadge() {
    const badge = $("runBadge");
    if (!badge) return;
    const caseInfo = caseByName(S.name);
    const running = !!(S.model && S.model.run && S.model.run.running) || !!(caseInfo && caseInfo.running);
    const stateName = running ? "running" : (caseInfo ? caseInfo.state : "ready");
    const meta = CASE_STATE[stateName] || CASE_STATE.ready;
    badge.className = `run-badge ${meta.cls}`;
    if ($("runState")) $("runState").textContent = meta.label;
    let extra = "";
    if (running) {
      const ranks = (S.model && S.model.run && S.model.run.ranks) || (caseInfo && caseInfo.ranks);
      extra = ranks ? `${ranks} 核` : "";
    } else if (caseInfo) {
      const latest = caseInfo.latest;
      const end = caseInfo.endTime;
      if (latest != null) extra = `${fmtNum(latest, 6)}${end != null ? ` / ${fmtNum(end, 6)} s` : " s"}`;
    }
    if ($("runMeta")) $("runMeta").textContent = extra;
    updateButtons();
  }

  async function pollState() {
    try {
      const data = await api("/api/state");
      S.cases = data.cases || [];
      renderCaseSelect();
      const caseInfo = caseByName(S.name);
      const running = !!(caseInfo && caseInfo.running);
      updateRunBadge();
      if (S.wasRunning && !running) {
        await refreshModel({ silent: true });
        toast("计算进程已结束", "ok", "运行状态");
      }
      S.wasRunning = running;
    } catch (_) { /* 静默重试 */ }
  }

  function startPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = setInterval(pollState, 4000);
  }

  // ------------------------------------------------------------------ //
  // 模型树
  // ------------------------------------------------------------------ //

  function renderTree() {
    const tree = $("tree");
    if (!tree) return;
    const model = S.model;
    if ($("treeCase")) $("treeCase").textContent = S.name || "未选择算例";
    if ($("solverChip")) $("solverChip").textContent = model ? (model.solver || "—") : "—";
    if ($("treePath")) $("treePath").textContent = model ? model.path : "—";
    tree.innerHTML = TREE_GROUPS.map(([group, ids]) => `
      <div class="tree-section">${group}</div>
      ${ids.map((id) => {
        const meta = SECTIONS[id];
        return `<button class="tree-item${S.section === id ? " active" : ""}" data-section="${id}">
          <svg class="ic"><use href="#${meta.icon}"/></svg>
          <span class="tree-label">${meta.title}</span>
          <span class="tree-tag">${TREE_TAGS[id]}</span>
        </button>`;
      }).join("")}
    `).join("");
  }

  async function switchSection(id) {
    if (!SECTIONS[id] || id === S.section) return;
    if (S.dirty) {
      const choice = await askUnsaved();
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await saveSection();
        if (!ok) return;
      } else {
        clearDirty();
      }
    }
    S.section = id;
    localStorage.setItem("ofm.section", id);
    renderTree();
    renderProps();
  }

  // ------------------------------------------------------------------ //
  // 属性面板
  // ------------------------------------------------------------------ //

  function renderProps() {
    const body = $("propsBody");
    if (!body) return;
    const meta = SECTIONS[S.section] || SECTIONS.general;
    if ($("propsTitle")) $("propsTitle").textContent = meta.title;
    if ($("propsSub")) $("propsSub").textContent = meta.sub;
    if (!S.model) {
      body.innerHTML = `<div class="empty-props">选择左侧算例后开始设置。</div>`;
      updateButtons();
      return;
    }
    let html = "";
    switch (S.section) {
      case "general": html = renderGeneral(); break;
      case "physics": html = renderPhysics(); break;
      case "fluid": html = renderFluid(); break;
      case "mesh": html = renderMesh(); break;
      case "initial": html = renderInitial(); break;
      case "boundary": html = renderBoundary(); break;
      case "numerics": html = renderNumerics(); break;
      case "output": html = renderOutput(); break;
      case "dict": html = renderDict(); break;
      default: html = renderGeneral();
    }
    body.innerHTML = html;
    body.scrollTop = 0;
    bindSection();
    updateButtons();
    if (S.section === "dict") loadDictIfNeeded();
  }

  function bindSection() {
    if (S.section === "physics") bindPhysics();
    if (S.section === "mesh") bindMesh();
    if (S.section === "boundary") bindBoundary();
    if (S.section === "numerics") bindNumerics();
    if (S.section === "dict") bindDict();
  }

  // ------------------------------------------------------------------ //
  // 通用
  // ------------------------------------------------------------------ //

  function renderGeneral() {
    const c = S.model.control || {};
    const solvers = Array.from(new Set([...(S.model.solverOptions || []), c.solver].filter(Boolean)));
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-general"/></svg>求解器与时间</div>
        ${field("求解器", select("g-solver", solvers, c.solver), "OpenFOAM 14 顶层求解器，例如 incompressibleFluid。")}
        <div class="grid-2">
          ${field("起始方式", select("g-startFrom", [
            { value: "latestTime", label: "latestTime" },
            { value: "startTime", label: "startTime" },
            { value: "firstTime", label: "firstTime" },
          ], c.startFrom), "从最新时间、指定时间或第一个时间继续。")}
          ${field("停止条件", select("g-stopAt", [
            { value: "endTime", label: "endTime" },
            { value: "writeNow", label: "writeNow" },
            { value: "noWriteNow", label: "noWriteNow" },
            { value: "nextWrite", label: "nextWrite" },
          ], c.stopAt), "endTime 按结束时间停止；其余用于控制写出时机。")}
        </div>
        <div class="grid-3">
          ${field("起始时间 / s", input("g-startTime", c.startTimeNum ?? c.startTime, 'type="number" step="any" min="0"'))}
          ${field("结束时间 / s", input("g-endTime", c.endTimeNum ?? c.endTime, 'type="number" step="any" min="0"'))}
          ${field("时间步长 / s", input("g-deltaT", c.deltaTNum ?? c.deltaT, 'type="number" step="any" min="1e-12"'))}
        </div>
        <div class="grid-3">
          ${field("最大库朗数", input("g-maxCo", c.maxCoNum ?? c.maxCo, 'type="number" step="any" min="1e-6"'))}
          ${field("最大时间步 / s", input("g-maxDeltaT", c.maxDeltaTNum ?? c.maxDeltaT, 'type="number" step="any" min="1e-12"'))}
          ${field("自动时间步", select("g-adjust", ["yes", "no"], c.adjustTimeStep || "no"))}
        </div>
      </div>
      <div class="note"><svg class="ic"><use href="#i-info"/></svg><span>保存后写入 <b>system/controlDict</b>。正在计算的算例不能修改设置，请先停止。</span></div>
      <div class="form-section">
        <div class="section-title">算例信息</div>
        <div class="kv"><span>路径</span><b>${esc(S.model.path)}</b></div>
        <div class="kv"><span>最近读取</span><b>${esc(S.model.updated || "—")}</b></div>
      </div>`;
  }

  function collectGeneral() {
    const solver = $("g-solver") ? $("g-solver").value : "";
    const startTime = $("g-startTime") ? Number($("g-startTime").value) : NaN;
    const endTime = $("g-endTime") ? Number($("g-endTime").value) : NaN;
    const deltaT = $("g-deltaT") ? Number($("g-deltaT").value) : NaN;
    if (!solver) { toast("请选择求解器", "error"); return null; }
    if (!Number.isFinite(startTime) || startTime < 0) { toast("起始时间需要非负数字", "error"); return null; }
    if (!Number.isFinite(endTime) || endTime <= startTime) { toast("结束时间必须大于起始时间", "error"); return null; }
    if (!Number.isFinite(deltaT) || deltaT <= 0) { toast("时间步长需要正数", "error"); return null; }
    const values = {
      solver,
      startFrom: $("g-startFrom").value,
      stopAt: $("g-stopAt").value,
      startTime,
      endTime,
      deltaT,
      adjustTimeStep: $("g-adjust").value,
    };
    const maxCo = $("g-maxCo") ? Number($("g-maxCo").value) : NaN;
    const maxDeltaT = $("g-maxDeltaT") ? Number($("g-maxDeltaT").value) : NaN;
    if (Number.isFinite(maxCo)) values.maxCo = maxCo;
    if (Number.isFinite(maxDeltaT)) values.maxDeltaT = maxDeltaT;
    return values;
  }

  // ------------------------------------------------------------------ //
  // 物理模型
  // ------------------------------------------------------------------ //

  function renderPhysics() {
    const p = S.model.physics || {};
    const sim = p.simulationType || "laminar";
    const models = sim === "LES" ? (S.model.lesModels || []) : (S.model.rasModels || []);
    const modelValue = p.model || (sim === "RAS" ? "kOmegaSST" : sim === "LES" ? "Smagorinsky" : "");
    const options = models.includes(modelValue) || !modelValue ? models : [modelValue, ...models];
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-physics"/></svg>湍流模型</div>
        <div class="field"><label>模拟类型</label>
          ${select("p-sim", [
            { value: "laminar", label: "laminar（层流）" },
            { value: "RAS", label: "RAS（雷诺平均）" },
            { value: "LES", label: "LES（大涡模拟）" },
          ], sim)}
          <div class="hint">切换到 RAS / LES 时会自动补充 wallDist，供 k-ω SST 等模型使用。</div>
        </div>
        ${field("湍流模型", select("p-model", options.length ? options : ["kOmegaSST"], modelValue, sim === "laminar" ? "disabled" : ""), sim === "laminar" ? "层流不需要选择湍流模型。" : "")}
      </div>
      <div class="form-section">
        <div class="section-title">重力</div>
        ${vecInputs("p-g", p.gravity || [0, 0, 0], ["gx", "gy", "gz"])}
        <div class="hint">写入 constant/g，单位为 m/s²。二维算例通常只需设置 gy。</div>
      </div>
      ${p.compressible ? `<div class="warn"><svg class="ic"><use href="#i-warning"/></svg><span>当前是可压缩算例，热物性（thermoType）结构较复杂，建议在“高级字典”中核对。</span></div>` : ""}
      <div class="note"><svg class="ic"><use href="#i-info"/></svg><span>配置文件：<b>${esc(p.file || "constant/momentumTransport")}</b>。切换模型不会自动添加 k / omega 等字段，缺失时请复制对应教程的 0/ 文件。</span></div>`;
  }

  function bindPhysics() {
    const sim = $("p-sim");
    const model = $("p-model");
    if (!sim || !model) return;
    const fill = () => {
      const type = sim.value;
      const list = type === "LES" ? (S.model.lesModels || []) : (S.model.rasModels || []);
      const current = model.value;
      const options = list.includes(current) || !current ? list : [current, ...list];
      model.innerHTML = options.map((name) =>
        `<option value="${esc(name)}"${name === current ? " selected" : ""}>${esc(name)}</option>`
      ).join("");
      model.disabled = type === "laminar";
    };
    sim.addEventListener("change", fill);
  }

  function collectPhysics() {
    const sim = $("p-sim").value;
    const model = sim === "laminar" ? "" : $("p-model").value;
    if (sim !== "laminar" && !model) { toast("请选择湍流模型", "error"); return null; }
    const gravity = [0, 1, 2].map((i) => Number($(`p-g-${i}`).value));
    if (gravity.some((n) => !Number.isFinite(n))) { toast("重力需要三个数字", "error"); return null; }
    return { simulationType: sim, model, gravity };
  }

  // ------------------------------------------------------------------ //
  // 流体属性
  // ------------------------------------------------------------------ //

  function renderFluid() {
    const f = S.model.fluid || {};
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-fluid"/></svg>物性</div>
        ${field("黏度模型", select("f-vm", S.model.viscosityModels || ["constant", "Newtonian"], f.viscosityModel || "constant"))}
        ${field("运动黏度 ν / m²·s⁻¹", input("f-nu", f.nu, 'type="number" step="any" min="1e-15"'), "ν = μ / ρ。水的量级约为 1e-6。")}
        ${field("密度 ρ / kg·m⁻³", input("f-rho", f.rho ?? "", 'type="number" step="any" min="1e-12" placeholder="可选"'), "不可压缩求解器不需要 ρ；设置后会同步到 forceCoeffs 的 rhoInf。")}
      </div>
      <div class="note"><svg class="ic"><use href="#i-info"/></svg><span>配置文件：<b>${esc(f.file || "constant/physicalProperties")}</b>。可压缩算例的热物性请使用“高级字典”。</span></div>
      ${f.thermoType ? `<div class="warn"><svg class="ic"><use href="#i-warning"/></svg><span>检测到 thermoType 热物性模型，表单只修改 ν 和 ρ，其余参数请保持原样。</span></div>` : ""}`;
  }

  function collectFluid() {
    const nu = Number($("f-nu").value);
    if (!Number.isFinite(nu) || nu <= 0) { toast("运动黏度需要正数", "error"); return null; }
    const values = { nu, viscosityModel: $("f-vm").value };
    const rhoText = $("f-rho").value.trim();
    if (rhoText) {
      const rho = Number(rhoText);
      if (!Number.isFinite(rho) || rho <= 0) { toast("密度需要正数", "error"); return null; }
      values.rho = rho;
    }
    return values;
  }

  // ------------------------------------------------------------------ //
  // 网格
  // ------------------------------------------------------------------ //

  function renderMesh() {
    const m = S.model.mesh || {};
    const cells = Array.isArray(m.cells) ? m.cells : null;
    const editable = !!(m.singleBlock && cells && m.blockMeshFile);
    const total = cells ? cells[0] * cells[1] * cells[2] : null;
    const patches = m.patches || [];
    const surface = m.surface;
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-mesh"/></svg>网格统计</div>
        <div class="mesh-stats">
          <div class="mesh-stat"><span>单元</span><b>${m.cellTotal != null ? m.cellTotal.toLocaleString("zh-CN") : "—"}</b></div>
          <div class="mesh-stat"><span>网格点</span><b>${m.polyPoints != null ? m.polyPoints.toLocaleString("zh-CN") : (m.vertexCount || "—")}</b></div>
          <div class="mesh-stat"><span>面</span><b>${m.polyFaces != null ? m.polyFaces.toLocaleString("zh-CN") : "—"}</b></div>
          <div class="mesh-stat"><span>块</span><b>${m.blockCount != null ? m.blockCount : "—"}</b></div>
        </div>
        ${m.blockCellTotal && m.polyCells && m.blockCellTotal !== m.polyCells
          ? `<div class="warn"><svg class="ic"><use href="#i-warning"/></svg><span>blockMeshDict 生成 ${m.blockCellTotal.toLocaleString("zh-CN")} 个单元，当前 polyMesh 有 ${m.polyCells.toLocaleString("zh-CN")} 个。3D 视图显示的是实际 polyMesh 表面。</span></div>`
          : ""}
        ${editable ? `
          <div class="grid-3">
            ${field("X 方向", input("m-nx", cells[0], 'type="number" step="1" min="1"'))}
            ${field("Y 方向", input("m-ny", cells[1], 'type="number" step="1" min="1"'))}
            ${field("Z 方向", input("m-nz", cells[2], 'type="number" step="1" min="1"'))}
          </div>
          <div class="hint">预计单元数：<b id="meshTotal">${total != null ? total.toLocaleString("zh-CN") : "—"}</b>。修改后需要重新“生成网格”。</div>
        ` : `<div class="note"><svg class="ic"><use href="#i-info"/></svg><span>${m.blockMeshFile ? "多块网格或块结构较复杂，请在“高级字典”中编辑 blockMeshDict。" : "没有 blockMeshDict，无法在表单中修改网格尺寸。"}</span></div>`}
      </div>
      <div class="form-section">
        <div class="section-title">边界</div>
        ${patches.length ? patches.map((p) => `
          <button type="button" class="kv patch-link" data-mesh-patch="${esc(p.name)}" title="在边界条件中查看 ${esc(p.name)}">
            <span>${esc(p.name)}</span><b>${esc(p.type || "patch")}${p.nFaces != null ? ` · ${p.nFaces} 面` : ""}</b>
          </button>
        `).join("") : `<div class="empty-props">没有边界信息</div>`}
      </div>
      <div class="form-section">
        <div class="section-title">生成与检查</div>
        <div class="mesh-actions">
          <button id="meshBlockBtn">生成网格 blockMesh</button>
          <button id="meshCheckBtn">检查网格 checkMesh</button>
        </div>
        <div class="field"><label>${S.meshLogTitle ? esc(S.meshLogTitle) : "最近日志"}</label>
          <div class="log-box" id="meshLog">${S.meshLog ? esc(S.meshLog) : "尚未运行 blockMesh / checkMesh"}</div>
        </div>
      </div>
      <div class="note"><svg class="ic"><use href="#i-info"/></svg><span>3D 视图：${surface ? `polyMesh 表面，${surface.patches.length} 个边界${surface.sampled ? "（已采样）" : ""}` : "blockMesh 几何"}。范围 ${m.bounds ? `${fmtNum(m.bounds.min[0], 4)}…${fmtNum(m.bounds.max[0], 4)} × ${fmtNum(m.bounds.min[1], 4)}…${fmtNum(m.bounds.max[1], 4)} × ${fmtNum(m.bounds.min[2], 4)}…${fmtNum(m.bounds.max[2], 4)}` : "—"}。</span></div>`;
  }

  function bindMesh() {
    const block = $("meshBlockBtn");
    const check = $("meshCheckBtn");
    if (block) block.addEventListener("click", doBlockMesh);
    if (check) check.addEventListener("click", doCheckMesh);
    $$("[data-mesh-patch]", $("propsBody")).forEach((btn) => {
      btn.addEventListener("click", () => focusPatch(btn.dataset.meshPatch));
    });
    const inputs = ["m-nx", "m-ny", "m-nz"].map((id) => $(id));
    const update = () => {
      if (!inputs.every(Boolean)) return;
      const nums = inputs.map((el) => parseInt(el.value, 10));
      const target = $("meshTotal");
      if (!target) return;
      target.textContent = nums.every((n) => Number.isFinite(n) && n > 0)
        ? (nums[0] * nums[1] * nums[2]).toLocaleString("zh-CN") : "—";
    };
    inputs.forEach((el) => el && el.addEventListener("input", update));
  }

  function collectMesh() {
    const m = S.model.mesh || {};
    if (!m.singleBlock || !Array.isArray(m.cells) || !m.blockMeshFile) {
      toast("该算例的网格尺寸请在“高级字典”中修改", "error");
      return null;
    }
    const nums = ["m-nx", "m-ny", "m-nz"].map((id) => parseInt($(id).value, 10));
    if (nums.some((n) => !Number.isFinite(n) || n < 1)) {
      toast("三个方向的网格数量都需要正整数", "error");
      return null;
    }
    return { cells: nums };
  }

  // ------------------------------------------------------------------ //
  // 初始条件
  // ------------------------------------------------------------------ //

  function renderInitial() {
    const fields = (S.model.fields && S.model.fields.list) || {};
    const names = Object.keys(fields);
    if (!names.length) {
      return `<div class="empty-props">0/ 目录中没有找到体积场文件。</div>`;
    }
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-initial"/></svg>内部场</div>
        <div class="note"><svg class="ic"><use href="#i-info"/></svg><span>修改 <b>0/${esc((S.model.fields && S.model.fields.folder) || "0")}</b> 中的 internalField。已经写出的时间目录不会改变。</span></div>
        ${names.map((name, index) => {
          const f = fields[name];
          const raw = String(f.internal || "");
          const nonuniform = /^\s*nonuniform\b/.test(raw);
          const kind = f.kind || "scalar";
          const vec = parseVec(raw);
          const scalar = parseScalar(raw);
          let control = "";
          if (nonuniform) {
            control = `<input value="${esc(raw)}" readonly><div class="hint">非均匀场，请在“高级字典”中编辑。</div>`;
          } else if (kind === "vector" && vec) {
            control = `<div class="grid-3">${["X", "Y", "Z"].map((label, i) => field(label,
              `<input id="init-${index}-${i}" data-init-comp="${i}" type="number" step="any" value="${esc(fmtNum(vec[i]))}">`
            )).join("")}</div>`;
          } else if (kind === "scalar" && scalar != null) {
            control = field("数值", `<input id="init-${index}-0" data-init-comp="0" type="number" step="any" value="${esc(fmtNum(scalar))}">`);
          } else {
            control = `<input id="init-${index}-raw" data-init-raw="1" value="${esc(raw)}">`;
          }
          return `<div class="patch-card init-card" data-init-name="${esc(name)}" data-init-kind="${esc(kind)}"${nonuniform ? ' data-init-skip="1"' : ""}>
            <div class="patch-head"><b>${esc(name)}</b><span>${esc(kind)} · ${esc(f.class || "")}</span></div>
            <div class="patch-body">${control}</div>
          </div>`;
        }).join("")}
      </div>`;
  }

  function collectInitial() {
    const values = {};
    let count = 0;
    $$(".init-card", $("propsBody")).forEach((card) => {
      if (card.dataset.initSkip) return;
      const name = card.dataset.initName;
      const kind = card.dataset.initKind;
      if (kind === "vector") {
        const comps = $$("[data-init-comp]", card).map((el) => Number(el.value));
        if (comps.length !== 3 || comps.some((n) => !Number.isFinite(n))) {
          toast(`${name} 需要三个分量`, "error");
          throw new Error("invalid");
        }
        values[name] = comps;
      } else if (kind === "scalar") {
        const n = Number(card.querySelector("[data-init-comp]").value);
        if (!Number.isFinite(n)) { toast(`${name} 需要数字`, "error"); throw new Error("invalid"); }
        values[name] = n;
      } else {
        const raw = card.querySelector("[data-init-raw]");
        if (raw && raw.value.trim()) values[name] = raw.value.trim();
      }
      count += 1;
    });
    if (!count) { toast("没有可修改的初始场", "error"); return null; }
    return { fields: values };
  }

  // ------------------------------------------------------------------ //
  // 边界条件
  // ------------------------------------------------------------------ //

  function renderBoundary() {
    const fields = (S.model.fields && S.model.fields.list) || {};
    const names = Object.keys(fields);
    if (!names.length) return `<div class="empty-props">0/ 目录中没有体积场。</div>`;
    if (!S.boundaryField || !fields[S.boundaryField]) S.boundaryField = names[0];
    const f = fields[S.boundaryField];
    const patches = f.patches || [];
    const extras = S.boundaryExtras[S.boundaryField] || {};
    patches.forEach((p) => { extras[p.name] = p.entries || {}; });
    S.boundaryExtras[S.boundaryField] = extras;
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-boundary"/></svg>场与边界</div>
        ${field("字段", select("b-field", names, S.boundaryField))}
        <div class="hint">字段 ${esc(S.boundaryField)} · ${esc(f.kind)} · ${patches.length} 个边界</div>
      </div>
      <div class="form-section">
        <div class="section-title">边界列表</div>
        <div class="patch-list">
          ${patches.map((p, index) => boundaryCard(p, index, f.kind, extras[p.name] || {})).join("")}
        </div>
      </div>
      <div class="note"><svg class="ic"><use href="#i-info"/></svg><span>保存后重写 <b>0/${esc(S.boundaryField)}</b> 的 boundaryField。原有附加项会尽量保留；复杂类型建议在“高级字典”中核对。也可以在 3D 视图中单击边界直接定位。</span></div>`;
  }

  function boundaryCard(patch, index, kind, extra) {
    const type = patch.type || "patch";
    const types = Array.from(new Set([...VALUE_BC, type])).sort((a, b) => a.localeCompare(b));
    const value = String(patch.value || "");
    const vec = parseVec(value);
    const scalar = parseScalar(value);
    let valueControl = "";
    if (kind === "vector" && vec) {
      valueControl = `<div class="grid-3">${["X", "Y", "Z"].map((label, i) => field(label,
        `<input data-bc-comp="${i}" type="number" step="any" value="${esc(fmtNum(vec[i]))}">`
      )).join("")}</div>`;
    } else if (kind === "scalar" && scalar != null) {
      valueControl = field("数值", `<input data-bc-comp="0" type="number" step="any" value="${esc(fmtNum(scalar))}">`);
    } else {
      valueControl = field("数值", `<input data-bc-raw="1" value="${esc(value)}">`);
    }
    const p0 = String(patch.p0 || "");
    const extraText = Object.entries(extra || {}).map(([k, v]) => `${k} ${v};`).join(" ");
    return `<div class="patch-card${S.selectedFieldPatch === patch.name ? " selected" : ""}" data-bc-patch="${esc(patch.name)}" data-bc-kind="${esc(kind)}">
      <div class="patch-head"><b>${esc(patch.name)}</b><span>${esc(kind)}</span></div>
      <div class="patch-body">
        ${field("类型", select(`bc-${index}-type`, types, type, `data-bc-type="1"`))}
        <div class="bc-value"${NO_VALUE_BC.has(type) || type === "totalPressure" ? ' style="display:none"' : ""}>${valueControl}</div>
        <div class="bc-p0"${type === "totalPressure" ? "" : ' style="display:none"'}>
          ${field("总压 p0", `<input data-bc-p0="1" value="${esc(p0)}" placeholder="uniform 0">`)}
        </div>
        ${extraText ? `<div class="hint">保留附加项：${esc(extraText)}</div>` : ""}
      </div>
    </div>`;
  }

  function bindBoundary() {
    const fieldSel = $("b-field");
    if (fieldSel) {
      fieldSel.addEventListener("change", async () => {
        if (S.dirty) {
          const choice = await askUnsaved();
          if (choice === "cancel") { fieldSel.value = S.boundaryField; return; }
          if (choice === "save") {
            const ok = await saveSection();
            if (!ok) { fieldSel.value = S.boundaryField; return; }
          } else clearDirty();
        }
        S.boundaryField = fieldSel.value;
        S.selectedFieldPatch = S.selectedPatch ? patchCardNameFor(S.boundaryField, S.selectedPatch) : "";
        renderProps();
      });
    }
    $$("[data-bc-type]", $("propsBody")).forEach((sel) => {
      const sync = () => {
        const card = sel.closest(".patch-card");
        const valueBox = card.querySelector(".bc-value");
        const p0Box = card.querySelector(".bc-p0");
        const type = sel.value;
        if (valueBox) valueBox.style.display = NO_VALUE_BC.has(type) || type === "totalPressure" ? "none" : "";
        if (p0Box) p0Box.style.display = type === "totalPressure" ? "" : "none";
      };
      sel.addEventListener("change", sync);
    });
  }

  function collectBoundary() {
    const field = S.boundaryField;
    if (!field) { toast("没有可保存的字段", "error"); return null; }
    const patches = [];
    let error = false;
    $$(".patch-card", $("propsBody")).forEach((card) => {
      if (error) return;
      const name = card.dataset.bcPatch;
      const kind = card.dataset.bcKind;
      const type = card.querySelector("[data-bc-type]").value;
      let value = "";
      if (!NO_VALUE_BC.has(type) && type !== "totalPressure") {
        if (kind === "vector") {
          const comps = $$("[data-bc-comp]", card).map((el) => Number(el.value));
          if (comps.length !== 3 || comps.some((n) => !Number.isFinite(n))) {
            toast(`${name} 需要三个速度分量`, "error");
            error = true;
            return;
          }
          value = comps;
        } else if (kind === "scalar") {
          const n = Number(card.querySelector("[data-bc-comp]").value);
          if (!Number.isFinite(n)) { toast(`${name} 需要数字`, "error"); error = true; return; }
          value = n;
        } else {
          value = card.querySelector("[data-bc-raw]").value.trim();
        }
      }
      const p0El = card.querySelector("[data-bc-p0]");
      const p0 = type === "totalPressure" && p0El ? p0El.value.trim() : "";
      if (type === "totalPressure" && !p0) { toast(`${name} 的 totalPressure 需要 p0`, "error"); error = true; return; }
      patches.push({
        patch: name, type, value, p0,
        extra: (S.boundaryExtras[field] && S.boundaryExtras[field][name]) || {},
      });
    });
    if (error) return null;
    if (!patches.length) { toast("没有边界可保存", "error"); return null; }
    return { field, patches };
  }

  // ------------------------------------------------------------------ //
  // 数值方法
  // ------------------------------------------------------------------ //

  const SCHEME_META = [
    ["ddtSchemes", "时间项 ddt", ["Euler", "backward", "CrankNicolson 0.9", "steadyState", "localEuler"]],
    ["gradSchemes", "梯度 grad", ["Gauss linear", "leastSquares", "cellLimited Gauss linear 1", "faceLimited Gauss linear 0.5"]],
    ["laplacianSchemes", "拉普拉斯 laplacian", ["Gauss linear corrected", "Gauss linear limited corrected 0.5", "Gauss linear uncorrected"]],
    ["interpolationSchemes", "插值 interpolation", ["linear", "cubic", "vanLeer"]],
    ["snGradSchemes", "面法向梯度 snGrad", ["corrected", "uncorrected", "limited corrected 0.5"]],
  ];

  function renderNumerics() {
    const schemes = S.model.schemes || {};
    const solution = S.model.solution || {};
    const algName = solution.PIMPLE ? "PIMPLE" : solution.SIMPLE ? "SIMPLE" : solution.PISO ? "PISO" : "PIMPLE";
    const alg = solution[algName] || {};
    const div = schemes.divSchemes || {};
    const solvers = solution.solvers || {};
    const exact = Object.entries(solvers).filter(([key, cfg]) =>
      cfg && typeof cfg === "object" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key));
    const skipped = Object.keys(solvers).filter((key) => !exact.some(([k]) => k === key));
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-numerics"/></svg>离散格式</div>
        ${SCHEME_META.map(([key, label, options]) => field(label,
          `<input id="n-${key}" value="${esc((schemes[key] && schemes[key].default) || "")}" list="dl-${key}">
           <datalist id="dl-${key}">${options.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>`
        )).join("")}
      </div>
      <div class="form-section">
        <div class="section-title">对流项 divSchemes</div>
        <div id="divRows">
          ${Object.entries(div).map(([key, value]) => divRow(key, value)).join("")}
        </div>
        <button class="mini-btn" id="divAdd" style="width:auto;padding:0 9px;margin-top:4px">+ 添加对流项</button>
      </div>
      <div class="form-section">
        <div class="section-title">压力-速度算法</div>
        <div class="grid-2">
          ${field("算法", select("n-alg", ["PIMPLE", "SIMPLE", "PISO"], algName))}
          ${field("nOuterCorrectors", input("n-outer", alg.nOuterCorrectors ?? 1, 'type="number" step="1" min="0"'))}
          ${field("nCorrectors", input("n-corr", alg.nCorrectors ?? 2, 'type="number" step="1" min="0"'))}
          ${field("nNonOrthogonalCorrectors", input("n-nonorth", alg.nNonOrthogonalCorrectors ?? 0, 'type="number" step="1" min="0"'))}
        </div>
      </div>
      <div class="form-section">
        <div class="section-title">线性求解器</div>
        <div id="solverRows">
          ${exact.map(([key, cfg]) => solverCard(key, cfg)).join("")}
        </div>
        <button class="mini-btn" id="solverAdd" style="width:auto;padding:0 9px;margin-top:4px">+ 添加求解器</button>
        ${skipped.length ? `<div class="hint">正则表达式求解器条目（如 <span class="mono">${esc(skipped[0])}</span>）请使用“高级字典”编辑。</div>` : ""}
      </div>
      <div class="note"><svg class="ic"><use href="#i-info"/></svg><span>保存后写入 <b>system/fvSchemes</b> 与 <b>system/fvSolution</b>。修改离散格式前建议先保存一份可运行的算例。</span></div>`;
  }

  function divRow(key = "", value = "") {
    return `<div class="div-row">
      <input data-div-key value="${esc(key)}" placeholder="div(phi,U)">
      <input data-div-value value="${esc(value)}" placeholder="Gauss linearUpwind grad(U)">
      <button class="row-del" data-div-remove title="删除">×</button>
    </div>`;
  }

  function solverCard(fieldName = "", cfg = {}) {
    return `<div class="solver-card" data-solver-card>
      <div class="patch-head"><b>${fieldName ? esc(fieldName) : "新求解器"}</b><span>linear solver</span></div>
      <div class="patch-body">
        <div class="inline-fields">
          ${field("字段名", `<input data-solver-field value="${esc(fieldName)}" placeholder="U">`)}
          ${field("求解器", `<input data-solver value="${esc(cfg.solver || "")}" placeholder="smoothSolver">`)}
          ${field("平滑器", `<input data-smoother value="${esc(cfg.smoother || "")}" placeholder="symGaussSeidel">`)}
          ${field("容差 tolerance", `<input data-tol type="number" step="any" min="0" value="${esc(fmtNum(cfg.tolerance))}">`)}
          ${field("相对容差 relTol", `<input data-reltol type="number" step="any" min="0" value="${esc(fmtNum(cfg.relTol))}">`)}
        </div>
      </div>
    </div>`;
  }

  function bindNumerics() {
    const addDiv = $("divAdd");
    if (addDiv) addDiv.addEventListener("click", () => {
      const rows = $("divRows");
      if (rows) rows.insertAdjacentHTML("beforeend", divRow());
    });
    const addSolver = $("solverAdd");
    if (addSolver) addSolver.addEventListener("click", () => {
      const rows = $("solverRows");
      if (rows) rows.insertAdjacentHTML("beforeend", solverCard());
    });
    $$("[data-div-remove]", $("propsBody")).forEach((btn) => btn.addEventListener("click", () => {
      const row = btn.closest(".div-row");
      if (row) row.remove();
    }));
  }

  function collectNumerics() {
    const schemes = {};
    SCHEME_META.forEach(([key]) => {
      const el = $(`n-${key}`);
      if (el && el.value.trim()) schemes[key] = el.value.trim();
    });
    const div = {};
    let bad = false;
    $$(".div-row", $("propsBody")).forEach((row) => {
      if (bad) return;
      const key = row.querySelector("[data-div-key]").value.trim();
      const value = row.querySelector("[data-div-value]").value.trim();
      if (!key && !value) return;
      if (!key || !value) { toast("对流项需要同时填写键和格式", "error"); bad = true; return; }
      div[key] = value;
    });
    if (bad) return null;
    const algorithm = { name: $("n-alg").value };
    for (const [id, key] of [["n-outer", "nOuterCorrectors"], ["n-corr", "nCorrectors"], ["n-nonorth", "nNonOrthogonalCorrectors"]]) {
      const el = $(id);
      if (!el || el.value.trim() === "") continue;
      const n = Number(el.value);
      if (!Number.isFinite(n) || n < 0 || Math.abs(n - Math.round(n)) > 1e-9) {
        toast(`${key} 需要非负整数`, "error");
        return null;
      }
      algorithm[key] = Math.round(n);
    }
    const solvers = {};
    let solverBad = false;
    $$("[data-solver-card]", $("propsBody")).forEach((card) => {
      if (solverBad) return;
      const name = card.querySelector("[data-solver-field]").value.trim();
      const cfg = {
        solver: card.querySelector("[data-solver]").value.trim(),
        smoother: card.querySelector("[data-smoother]").value.trim(),
        tolerance: card.querySelector("[data-tol]").value.trim(),
        relTol: card.querySelector("[data-reltol]").value.trim(),
      };
      if (!name && !cfg.solver && !cfg.smoother && !cfg.tolerance && !cfg.relTol) return;
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name)) {
        toast(`求解器字段名不合法：${name || "（空）"}`, "error");
        solverBad = true;
        return;
      }
      const entry = {};
      for (const [key, value] of Object.entries(cfg)) {
        if (!value) continue;
        if (key === "tolerance" || key === "relTol") {
          const n = Number(value);
          if (!Number.isFinite(n) || n < 0) { toast(`${name} 的 ${key} 需要非负数`, "error"); solverBad = true; return; }
          entry[key] = n;
        } else entry[key] = value;
      }
      solvers[name] = entry;
    });
    if (solverBad) return null;
    return { schemes, div, algorithm, solvers };
  }

  // ------------------------------------------------------------------ //
  // 输出控制
  // ------------------------------------------------------------------ //

  function renderOutput() {
    const c = S.model.control || {};
    const force = (S.model.functions || []).find((f) => f.type === "forceCoeffs");
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-output"/></svg>写出控制</div>
        <div class="grid-2">
          ${field("写出控制", select("o-writeControl", [
            { value: "runTime", label: "runTime" },
            { value: "adjustableRunTime", label: "adjustableRunTime" },
            { value: "timeStep", label: "timeStep" },
            { value: "clockTime", label: "clockTime" },
            { value: "cpuTime", label: "cpuTime" },
          ], c.writeControl), "按物理时间、自适应步长、时间步数、墙上时间或 CPU 时间写出。")}
          ${field("写出间隔", input("o-writeInterval", c.writeIntervalNum ?? c.writeInterval, 'type="number" step="any" min="1e-9"'))}
          ${field("保留数量 purgeWrite", input("o-purgeWrite", c.purgeWriteNum ?? c.purgeWrite, 'type="number" step="1" min="0"'), "0 表示保留全部时间目录。")}
          ${field("写出格式", select("o-writeFormat", ["ascii", "binary"], c.writeFormat))}
          ${field("压缩", select("o-writeCompression", ["off", "on"], c.writeCompression))}
          ${field("运行时修改字典", select("o-runTimeModifiable", ["yes", "no"], c.runTimeModifiable))}
        </div>
      </div>
      <div class="form-section">
        <div class="section-title">函数对象</div>
        ${force ? `
          <div class="patch-card">
            <div class="patch-head"><b>forceCoeffs</b><span>力系数</span></div>
            <div class="patch-body">
              ${field("监测边界", `<input id="o-force-patches" value="${esc((force.patches || []).join(" "))}" placeholder="cylinder">`, "多个边界用空格分隔。")}
              <div class="inline-fields">
                ${field("参考面积 Aref", input("o-force-Aref", force.Aref, 'type="number" step="any" min="0"'))}
                ${field("参考密度 rhoInf", input("o-force-rhoInf", force.rhoInf, 'type="number" step="any" min="0"'))}
                ${field("参考速度 magUInf", input("o-force-magUInf", force.magUInf, 'type="number" step="any" min="0"'))}
                ${field("参考长度 lRef", input("o-force-lRef", force.lRef, 'type="number" step="any" min="0"'))}
              </div>
            </div>
          </div>` : `<div class="empty-props">当前 controlDict 中没有 forceCoeffs 函数。</div>`}
        ${(S.model.functions || []).length ? `<div class="hint">检测到函数：${esc((S.model.functions || []).map((f) => `${f.name}（${f.type}）`).join("、"))}</div>` : ""}
      </div>
      <div class="note"><svg class="ic"><use href="#i-info"/></svg><span>保存后写入 <b>system/controlDict</b>。力系数用于升力/阻力曲线，后处理页会读取 postProcessing 中的结果。</span></div>`;
  }

  function collectOutput() {
    const values = {
      writeControl: $("o-writeControl").value,
      writeFormat: $("o-writeFormat").value,
      writeCompression: $("o-writeCompression").value,
      runTimeModifiable: $("o-runTimeModifiable").value,
    };
    const interval = Number($("o-writeInterval").value);
    if (!Number.isFinite(interval) || interval <= 0) { toast("写出间隔需要正数", "error"); return null; }
    values.writeInterval = interval;
    const purge = Number($("o-purgeWrite").value);
    if (!Number.isFinite(purge) || purge < 0 || Math.abs(purge - Math.round(purge)) > 1e-9) {
      toast("保留数量需要非负整数", "error"); return null;
    }
    values.purgeWrite = Math.round(purge);
    const force = (S.model.functions || []).find((f) => f.type === "forceCoeffs");
    if (force) {
      const patches = $("o-force-patches").value.split(/[\s,]+/).filter(Boolean);
      if (!patches.length) { toast("力系数至少需要一个边界", "error"); return null; }
      const cfg = { patches };
      for (const [id, key] of [["o-force-Aref", "Aref"], ["o-force-rhoInf", "rhoInf"],
        ["o-force-magUInf", "magUInf"], ["o-force-lRef", "lRef"]]) {
        const el = $(id);
        if (!el || el.value.trim() === "") continue;
        const n = Number(el.value);
        if (!Number.isFinite(n) || n < 0) { toast(`${key} 需要非负数`, "error"); return null; }
        cfg[key] = n;
      }
      values.forceCoeffs = cfg;
    }
    return values;
  }

  // ------------------------------------------------------------------ //
  // 高级字典
  // ------------------------------------------------------------------ //

  function dictFiles() {
    if (S.detail && S.detail.dicts && S.detail.dicts.length) return S.detail.dicts;
    return [
      { group: "system", path: "system/controlDict", name: "controlDict", size: null, mtime: "" },
      { group: "system", path: "system/fvSchemes", name: "fvSchemes", size: null, mtime: "" },
      { group: "system", path: "system/fvSolution", name: "fvSolution", size: null, mtime: "" },
      { group: "system", path: "system/blockMeshDict", name: "blockMeshDict", size: null, mtime: "" },
      { group: "constant", path: "constant/physicalProperties", name: "physicalProperties", size: null, mtime: "" },
      { group: "constant", path: "constant/momentumTransport", name: "momentumTransport", size: null, mtime: "" },
      { group: "0", path: "0/U", name: "U", size: null, mtime: "" },
      { group: "0", path: "0/p", name: "p", size: null, mtime: "" },
    ];
  }

  function dictOptions() {
    const files = dictFiles();
    const groups = {};
    files.forEach((item) => {
      const group = item.group || "其他";
      (groups[group] = groups[group] || []).push(item);
    });
    return Object.entries(groups).map(([group, items]) => `
      <optgroup label="${esc(group)}">
        ${items.map((item) => `<option value="${esc(item.path)}"${item.path === S.dictFile ? " selected" : ""}>${esc(item.name)}</option>`).join("")}
      </optgroup>`).join("");
  }

  function renderDict() {
    const file = dictFiles().find((item) => item.path === S.dictFile);
    return `
      <div class="form-section">
        <div class="section-title"><svg class="ic"><use href="#i-dict"/></svg>字典文件</div>
        ${field("文件", `<select id="dictFile">${dictOptions()}</select>`)}
        <div class="hint">${file ? `${esc(file.path)} · ${file.size != null ? `${file.size} 字节 · ` : ""}${esc(file.mtime || "")}` : "文件列表读取中…"}</div>
      </div>
      <div class="form-section">
        <div class="section-title">内容</div>
        <textarea class="dict-area" id="dictText" spellcheck="false" wrap="off" placeholder="正在加载…">${esc(S.dictLoadedFor === S.dictFile ? S.dictText : "")}</textarea>
      </div>
      <div class="mesh-actions">
        <button id="dictReload">重新读取</button>
        <button id="dictSave">保存字典</button>
      </div>
      <div class="warn"><svg class="ic"><use href="#i-warning"/></svg><span>直接编辑字典会绕过表单校验。保存前请确认括号、分号和单位正确；保存后会自动刷新模型数据。</span></div>`;
  }

  function bindDict() {
    const fileSel = $("dictFile");
    if (fileSel) fileSel.addEventListener("change", async () => {
      if (S.dirty) {
        const choice = await askUnsaved();
        if (choice === "cancel") { fileSel.value = S.dictFile; return; }
        if (choice === "save") {
          const ok = await saveDict();
          if (!ok) { fileSel.value = S.dictFile; return; }
        } else clearDirty();
      }
      S.dictFile = fileSel.value;
      localStorage.setItem("ofm.dict", S.dictFile);
      S.dictLoadedFor = "";
      S.dictText = "";
      loadDict(S.dictFile, true).catch((err) => toast(err.message, "error", "读取字典失败"));
    });
    const reload = $("dictReload");
    if (reload) reload.addEventListener("click", async () => {
      if (S.dirty) {
        const ok = await confirmDialog({ title: "放弃未保存的修改？", body: "重新读取会覆盖文本框中的内容。", okText: "重新读取" });
        if (!ok) return;
        clearDirty();
      }
      loadDict(S.dictFile, true).catch((err) => toast(err.message, "error", "读取字典失败"));
    });
    const save = $("dictSave");
    if (save) save.addEventListener("click", () => { saveDict(); });
    const area = $("dictText");
    if (area) area.addEventListener("input", () => { S.dictDirty = true; markDirty(); });
  }

  async function loadDictIfNeeded() {
    if (S.section !== "dict" || !S.name) return;
    try {
      if (!S.detail || S.detail.name !== S.name) {
        await ensureDetail();
        if (S.section === "dict") {
          const sel = $("dictFile");
          if (sel) sel.innerHTML = dictOptions();
        }
      }
      await loadDict(S.dictFile, false);
    } catch (err) {
      toast(err.message, "error", "读取字典失败");
    }
  }

  async function loadDict(file, force = false) {
    if (!file) return;
    const area = $("dictText");
    if (!force && S.dictLoadedFor === file && S.dictText) {
      if (area) area.value = S.dictText;
      return;
    }
    if (area) area.value = "正在加载…";
    const data = await api(`/api/dict?name=${enc(S.name)}&file=${enc(file)}`);
    if (S.section !== "dict" || S.dictFile !== file) return;
    S.dictText = data.text || "";
    S.dictLoadedFor = file;
    if (area) area.value = S.dictText;
    const hint = $("propsBody") && $("propsBody").querySelector(".hint");
    if (hint) hint.textContent = `${data.path} · ${data.size} 字节 · ${data.mtime}`;
  }

  async function saveDict() {
    if (!S.model || !$("dictText")) return false;
    const text = $("dictText").value;
    setBusy(true, "正在保存字典…");
    try {
      await post("/api/dict/save", { name: S.name, file: S.dictFile, text });
      S.dictText = text;
      S.dictLoadedFor = S.dictFile;
      clearDirty();
      toast("字典已保存", "ok");
      await refreshModel({ silent: true });
      return true;
    } catch (err) {
      showError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ //
  // 保存分区
  // ------------------------------------------------------------------ //

  async function saveSection() {
    if (!S.model) return false;
    if (S.section === "dict") return saveDict();
    let values = null;
    try {
      if (S.section === "general") values = collectGeneral();
      else if (S.section === "physics") values = collectPhysics();
      else if (S.section === "fluid") values = collectFluid();
      else if (S.section === "mesh") values = collectMesh();
      else if (S.section === "initial") values = collectInitial();
      else if (S.section === "boundary") values = collectBoundary();
      else if (S.section === "numerics") values = collectNumerics();
      else if (S.section === "output") values = collectOutput();
    } catch (err) {
      return false;
    }
    if (!values) return false;
    setBusy(true, "正在写入 OpenFOAM 字典…");
    try {
      const model = await post("/api/model/save", { name: S.name, section: S.section, values });
      S.model = model;
      clearDirty();
      toast(`${SECTIONS[S.section].title}已保存`, "ok");
      renderTree();
      renderViewport();
      renderProps();
      updateRunBadge();
      updateButtons();
      const warnings = model.warnings || [];
      if ($("statusWarn")) {
        $("statusWarn").textContent = warnings.length ? `${warnings.length} 条提示` : "";
        $("statusWarn").title = warnings.join("\n");
      }
      return true;
    } catch (err) {
      showError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ //
  // 3D 视图
  // ------------------------------------------------------------------ //

  const PATCH_PALETTE = ["#0071e3", "#ff3b30", "#ff9500", "#34c759", "#af52de", "#5ac8fa", "#ff2d55", "#5856d6"];
  let CTX = null;

  function patchColor(name, type, index) {
    const n = String(name || "").toLowerCase();
    if (n.includes("inlet") && !n.includes("outlet")) return "#0071e3";
    if (n.includes("outlet")) return "#ff3b30";
    if (n.includes("wall")) return "#ff9500";
    if (n.includes("cyl")) return "#af52de";
    if (n.includes("top") || n.includes("bottom")) return "#34c759";
    if (type === "wall") return "#ff9500";
    if (type === "empty") return "#8e8e93";
    return PATCH_PALETTE[index % PATCH_PALETTE.length];
  }

  function sceneData() {
    if (!S.model || !S.model.mesh) return null;
    const mesh = S.model.mesh;
    const surface = mesh.surface;
    let bounds = (surface && surface.bounds) || mesh.bounds;
    if (!bounds || !bounds.min || !bounds.max) return null;
    const min = bounds.min.slice();
    const max = bounds.max.slice();
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const pad = Math.max(diag * 0.03, 1e-9);
    for (let i = 0; i < 3; i += 1) {
      if (max[i] - min[i] < pad) { min[i] -= pad; max[i] += pad; }
    }
    return { mesh, surface, bounds: { min, max }, diag };
  }

  function fitView(redraw = true) {
    const scene = sceneData();
    if (!scene) return;
    S.view.dist = 1.55;
    S.view.auto = false;
    S.view.hover = "";
    if (redraw) drawScene();
  }

  function resetView() {
    S.view.yaw = -0.82;
    S.view.pitch = 0.42;
    S.view.dist = 1.65;
    S.view.auto = false;
    S.view.hover = "";
    drawScene();
  }

  function renderViewport() {
    const scene = sceneData();
    const legend = $("vpLegend");
    const empty = $("vpEmpty");
    const mesh = S.model && S.model.mesh;
    const surface = mesh && mesh.surface;
    const patches = (surface && surface.patches) || (mesh && mesh.patches) || [];
    if (S.selectedPatch && !patches.some((p) => p.name === S.selectedPatch)) {
      S.selectedPatch = "";
      S.selectedFieldPatch = "";
      S.view.hover = "";
    }
    if ($("statPatches")) $("statPatches").textContent = patches.length || "—";
    if ($("statCells")) $("statCells").textContent = mesh && mesh.cellTotal != null ? mesh.cellTotal.toLocaleString("zh-CN") : "—";
    if ($("statBlocks")) $("statBlocks").textContent = mesh && mesh.blockCount != null ? mesh.blockCount : "—";
    if ($("statBounds")) {
      const b = scene && scene.bounds;
      $("statBounds").textContent = b
        ? `${fmtNum(b.max[0] - b.min[0], 3)} × ${fmtNum(b.max[1] - b.min[1], 3)} × ${fmtNum(b.max[2] - b.min[2], 3)}`
        : "—";
    }
    if ($("vpBadge")) {
      if (!mesh) $("vpBadge").textContent = "—";
      else if (surface) $("vpBadge").textContent = `polyMesh · ${patches.length} 边界${surface.sampled ? " · 采样" : ""}`;
      else if (mesh.cells) $("vpBadge").textContent = `blockMesh · ${mesh.cells.join(" × ")}`;
      else $("vpBadge").textContent = "blockMesh 几何";
    }
    if (legend) {
      legend.innerHTML = patches.slice(0, 8).map((p, i) => {
        const color = patchColor(p.name, p.type, i);
        const active = S.selectedPatch === p.name;
        return `<button type="button" class="lg-row${active ? " active" : ""}" data-patch="${esc(p.name)}" title="查看 ${esc(p.name)} 的边界条件" aria-pressed="${active}"><span class="sw" style="background:${color}"></span><span>${esc(p.name)}</span></button>`;
      }).join("") + (patches.length > 8 ? `<div class="lg-row"><span class="sw" style="background:#aab7c3"></span><span>+${patches.length - 8}</span></div>` : "");
    }
    if (empty) empty.hidden = !!scene;
    if (S.model && S.view.case !== S.name) {
      S.view.case = S.name;
      fitView(false);
    }
    drawScene();
  }

  function resizeCanvas() {
    const wrap = $("canvasWrap");
    const canvas = $("view");
    if (!wrap || !canvas) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.canvas.W = Math.max(1, rect.width);
    S.canvas.H = Math.max(1, rect.height);
    S.canvas.dpr = dpr;
    canvas.width = Math.round(S.canvas.W * dpr);
    canvas.height = Math.round(S.canvas.H * dpr);
    CTX = canvas.getContext("2d");
    if (CTX) CTX.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene();
  }

  function initViewport() {
    const canvas = $("view");
    const wrap = $("canvasWrap");
    if (!canvas || !wrap) return;
    resizeCanvas();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => resizeCanvas());
      ro.observe(wrap);
    } else {
      window.addEventListener("resize", resizeCanvas);
    }
    const legend = $("vpLegend");
    if (legend) {
      legend.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-patch]");
        if (btn) focusPatch(btn.dataset.patch);
      });
    }
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      S.drag = {
        x: event.clientX, y: event.clientY,
        startX: event.clientX, startY: event.clientY, moved: false,
      };
      try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
      canvas.style.cursor = "grabbing";
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!S.drag) {
        const hit = pickPatch(event);
        const patch = hit ? hit.patch : "";
        if (patch !== S.view.hover) {
          S.view.hover = patch;
          canvas.style.cursor = patch ? "pointer" : "grab";
          drawScene();
        }
        return;
      }
      const dx = event.clientX - S.drag.x;
      const dy = event.clientY - S.drag.y;
      if (!S.drag.moved && Math.hypot(event.clientX - S.drag.startX, event.clientY - S.drag.startY) < 4) return;
      S.drag.moved = true;
      S.drag.x = event.clientX;
      S.drag.y = event.clientY;
      S.view.yaw -= dx * 0.008;
      S.view.pitch = clamp(S.view.pitch + dy * 0.008, -1.42, 1.42);
      S.view.hover = "";
      drawScene();
    });
    const stopDrag = (event) => {
      const drag = S.drag;
      S.drag = null;
      if (!drag) return;
      canvas.style.cursor = "grab";
      if (!drag.moved && event && event.type === "pointerup") {
        const hit = pickPatch(event);
        if (hit) {
          S.view.hover = hit.patch;
          focusPatch(hit.patch);
        }
      }
    };
    canvas.addEventListener("pointerup", stopDrag);
    canvas.addEventListener("pointercancel", stopDrag);
    canvas.addEventListener("pointerleave", () => {
      if (S.drag || !S.view.hover) return;
      S.view.hover = "";
      canvas.style.cursor = "grab";
      drawScene();
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      S.view.dist = clamp(S.view.dist * Math.exp(event.deltaY * 0.0011), 0.35, 8);
      S.view.hover = "";
      drawScene();
    }, { passive: false });
    canvas.addEventListener("dblclick", resetView);
    if ($("viewFit")) $("viewFit").addEventListener("click", () => fitView());
    if ($("viewReset")) $("viewReset").addEventListener("click", resetView);
  }

  const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const vnorm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };

  function makeCamera(scene) {
    const { bounds } = scene;
    const center = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const diag = Math.hypot(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    ) || 1;
    const dist = S.view.dist * diag;
    const cp = Math.cos(S.view.pitch);
    const sp = Math.sin(S.view.pitch);
    const cy = Math.cos(S.view.yaw);
    const sy = Math.sin(S.view.yaw);
    const eye = [center[0] + dist * cp * cy, center[1] + dist * cp * sy, center[2] + dist * sp];
    const forward = vnorm(vsub(center, eye));
    let right = vnorm(vcross(forward, [0, 0, 1]));
    if (!Number.isFinite(right[0]) || Math.hypot(...right) < 1e-6) right = [1, 0, 0];
    const up = vcross(right, forward);
    const focal = 1 / Math.tan((45 * Math.PI / 180) / 2);
    return { eye, forward, right, up, focal, center, diag };
  }

  function projectPoint(point, cam) {
    const v = vsub(point, cam.eye);
    const depth = vdot(v, cam.forward);
    if (depth <= cam.diag * 0.015) return null;
    const x = vdot(v, cam.right);
    const y = vdot(v, cam.up);
    const scale = cam.focal * (S.canvas.H / 2) / depth;
    return { x: S.canvas.W / 2 + x * scale, y: S.canvas.H / 2 - y * scale, depth };
  }

  function drawScene() {
    if (!CTX) return;
    const W = S.canvas.W;
    const H = S.canvas.H;
    if (!W || !H) return;
    CTX.clearRect(0, 0, W, H);
    const scene = sceneData();
    if (!scene) return;
    const cam = makeCamera(scene);
    drawGrid(CTX, cam, scene);
    if (scene.surface && scene.surface.patches.length) {
      drawSurface(CTX, cam, scene);
      drawBBox(CTX, cam, scene);
    } else {
      drawBlockMesh(CTX, cam, scene);
    }
    drawAxes(CTX, cam, scene);
    drawLabels(CTX, cam, scene);
  }

  function drawGrid(ctx, cam, scene) {
    const { min, max } = scene.bounds;
    const z = min[2];
    const n = 8;
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.045)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= n; i += 1) {
      const x = min[0] + (max[0] - min[0]) * i / n;
      const y = min[1] + (max[1] - min[1]) * i / n;
      stroke3D(ctx, cam, [[x, min[1], z], [x, max[1], z]]);
      stroke3D(ctx, cam, [[min[0], y, z], [max[0], y, z]]);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.09)";
    stroke3D(ctx, cam, [[min[0], min[1], z], [max[0], min[1], z], [max[0], max[1], z], [min[0], max[1], z], [min[0], min[1], z]]);
    ctx.restore();
  }

  function stroke3D(ctx, cam, points) {
    let started = false;
    ctx.beginPath();
    points.forEach((point) => {
      if (!point) { started = false; return; }
      const p = projectPoint(point, cam);
      if (!p) { started = false; return; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }

  function drawBBox(ctx, cam, scene) {
    const { min, max } = scene.bounds;
    const corners = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]],
      [min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]],
    ];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.16)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    edges.forEach(([a, b]) => stroke3D(ctx, cam, [corners[a], corners[b]]));
    ctx.restore();
  }

  function blockEdges(type) {
    if (type === "tet") return [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [2, 3]];
    if (type === "wedge" || type === "prism") return [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]];
    return [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  }

  function trilinear(block, vertices, u, v, w) {
    const ids = block.vertices || [];
    if (ids.length < 8) return null;
    const c = ids.slice(0, 8).map((i) => vertices[i]);
    if (c.some((p) => !p)) return null;
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const x00 = lerp(c[0], c[1], u);
    const x10 = lerp(c[3], c[2], u);
    const x01 = lerp(c[4], c[5], u);
    const x11 = lerp(c[7], c[6], u);
    const y0 = lerp(x00, x10, v);
    const y1 = lerp(x01, x11, v);
    return lerp(y0, y1, w);
  }

  function drawBlockMesh(ctx, cam, scene) {
    const { mesh } = scene;
    const vertices = mesh.vertices || [];
    const blocks = mesh.blocks || [];
    ctx.save();
    ctx.strokeStyle = "rgba(0,113,227,0.42)";
    ctx.lineWidth = 1.1;
    blocks.forEach((block) => {
      const ids = block.vertices || [];
      blockEdges(block.type).forEach(([a, b]) => {
        const pa = vertices[ids[a]];
        const pb = vertices[ids[b]];
        if (pa && pb) stroke3D(ctx, cam, [pa, pb]);
      });
    });
    const single = blocks.length === 1 ? blocks[0] : null;
    const singleIds = single && Array.isArray(single.vertices) ? single.vertices.slice(0, 8) : [];
    if (single && Array.isArray(single.cells) && single.cells.length >= 3
        && singleIds.length === 8 && singleIds.every((i) => vertices[i])) {
      const cells = single.cells;
      const n = cells.map((value) => Math.min(Math.max(1, value), 14));
      ctx.strokeStyle = "rgba(0,113,227,0.14)";
      ctx.lineWidth = 0.7;
      for (let i = 1; i < n[0]; i += 1) {
        const u = i / n[0];
        stroke3D(ctx, cam, [trilinear(single, vertices, u, 0, 0), trilinear(single, vertices, u, 1, 0)]);
        stroke3D(ctx, cam, [trilinear(single, vertices, u, 0, 1), trilinear(single, vertices, u, 1, 1)]);
      }
      for (let j = 1; j < n[1]; j += 1) {
        const v = j / n[1];
        stroke3D(ctx, cam, [trilinear(single, vertices, 0, v, 0), trilinear(single, vertices, 1, v, 0)]);
        stroke3D(ctx, cam, [trilinear(single, vertices, 0, v, 1), trilinear(single, vertices, 1, v, 1)]);
      }
      for (let k = 1; k < n[2]; k += 1) {
        const w = k / n[2];
        stroke3D(ctx, cam, [trilinear(single, vertices, 0, 0, w), trilinear(single, vertices, 1, 0, w)]);
        stroke3D(ctx, cam, [trilinear(single, vertices, 0, 1, w), trilinear(single, vertices, 1, 1, w)]);
      }
    }
    ctx.restore();
  }

  function drawSurface(ctx, cam, scene) {
    const faces = [];
    scene.surface.patches.forEach((patch, index) => {
      const color = patchColor(patch.name, patch.type, index);
      (patch.faces || []).forEach((face) => {
        const projected = face.map((point) => projectPoint(point, cam));
        if (projected.some((p) => !p)) return;
        const depth = projected.reduce((sum, p) => sum + p.depth, 0) / projected.length;
        faces.push({ points: projected, depth, color, patch: patch.name });
      });
    });
    faces.sort((a, b) => b.depth - a.depth);
    S.view.faces = faces;
    ctx.save();
    ctx.lineJoin = "round";
    faces.forEach((face) => {
      const selected = !!S.selectedPatch && face.patch === S.selectedPatch;
      const hover = !selected && !!S.view.hover && face.patch === S.view.hover;
      ctx.beginPath();
      face.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.closePath();
      ctx.fillStyle = hexRgba(face.color, selected ? 0.34 : hover ? 0.24 : 0.15);
      ctx.fill();
      ctx.strokeStyle = hexRgba(face.color, selected ? 1 : hover ? 0.96 : 0.85);
      ctx.lineWidth = selected ? 1.9 : hover ? 1.25 : 0.85;
      ctx.stroke();
    });
    ctx.restore();
  }

  function drawAxes(ctx, cam, scene) {
    const { min, max } = scene.bounds;
    const origin = [min[0], min[1], min[2]];
    const len = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 0.18;
    const axes = [
      { p: [origin[0] + len, origin[1], origin[2]], color: "#ff3b30", label: "X" },
      { p: [origin[0], origin[1] + len, origin[2]], color: "#34c759", label: "Y" },
      { p: [origin[0], origin[1], origin[2] + len], color: "#0071e3", label: "Z" },
    ];
    const o = projectPoint(origin, cam);
    if (!o) return;
    ctx.save();
    ctx.lineWidth = 1.8;
    ctx.font = "600 11px 'Microsoft YaHei UI', sans-serif";
    axes.forEach((axis) => {
      const p = projectPoint(axis.p, cam);
      if (!p) return;
      ctx.strokeStyle = axis.color;
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = axis.color;
      ctx.fillText(axis.label, p.x + 4, p.y - 4);
    });
    ctx.fillStyle = "rgba(29,29,31,.55)";
    ctx.beginPath();
    ctx.arc(o.x, o.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawLabels(ctx, cam, scene) {
    const patches = scene.surface ? scene.surface.patches : [];
    if (!patches.length) return;
    const occupied = [];
    ctx.save();
    ctx.font = "10px 'Microsoft YaHei UI', sans-serif";
    patches.slice(0, 8).forEach((patch, index) => {
      const points = [];
      (patch.faces || []).forEach((face) => face.forEach((p) => points.push(p)));
      if (!points.length) return;
      const centroid = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0])
        .map((v) => v / points.length);
      const p = projectPoint(centroid, cam);
      if (!p || p.x < 0 || p.y < 0 || p.x > S.canvas.W || p.y > S.canvas.H) return;
      const text = patch.name;
      const width = ctx.measureText(text).width + 12;
      const height = 17;
      let x = p.x + 9;
      let y = p.y - 9 - (index % 2) * 14;
      if (x + width > S.canvas.W - 4) x = p.x - width - 9;
      if (y < 4) y = p.y + 10;
      for (const rect of occupied) {
        if (x < rect.x + rect.w + 4 && x + width + 4 > rect.x && y < rect.y + rect.h + 3 && y + height + 3 > rect.y) {
          y += height + 3;
        }
      }
      occupied.push({ x, y, w: width, h: height });
      const color = patchColor(patch.name, patch.type, index);
      const selected = patch.name === S.selectedPatch;
      ctx.strokeStyle = hexRgba(color, 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(x + (x > p.x ? 0 : width), y + height / 2);
      ctx.stroke();
      ctx.fillStyle = selected ? "rgba(0,113,227,.95)" : "rgba(255,255,255,.92)";
      ctx.strokeStyle = selected ? "rgba(0,113,227,.95)" : "rgba(0,0,0,.08)";
      roundRect(ctx, x, y, width, height, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = selected ? "#ffffff" : "#1d1d1f";
      ctx.fillText(text, x + 6, y + 12);
    });
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ------------------------------------------------------------------ //
  // 操作
  // ------------------------------------------------------------------ //

  async function doBlockMesh() {
    if (!S.model || S.busy) return;
    if (!S.model.mesh.blockMeshFile) { toast("该算例没有 blockMeshDict", "error"); return; }
    const ok = await confirmDialog({
      title: "重新生成网格？",
      sub: "blockMesh 会覆盖 constant/polyMesh 和已有计算结果。",
      body: "如果只是想检查现有网格，请使用“检查网格 checkMesh”。",
      okText: "生成网格",
      danger: true,
    });
    if (!ok) return;
    setBusy(true, "正在运行 blockMesh…");
    try {
      const res = await post("/api/blockmesh", { name: S.name });
      if (res.mesh) S.model.mesh = res.mesh;
      S.meshLog = (res.lines || []).join("\n");
      S.meshLogTitle = res.log || "blockMesh";
      renderViewport();
      if (S.section === "mesh") renderProps();
      toast(`网格已生成${res.mesh && res.mesh.cellTotal != null ? `：${res.mesh.cellTotal.toLocaleString("zh-CN")} 个单元` : ""}`, "ok", "blockMesh");
      await refreshModel({ silent: true });
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function pollJob(id) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const job = await api(`/api/job?id=${enc(id)}`);
      if (job.status === "done" || job.status === "error") return job;
      setStatus(job.message || "checkMesh 正在运行…", "busy");
      await sleep(1200);
    }
    throw new Error("checkMesh 超时（超过 10 分钟）");
  }

  async function doCheckMesh() {
    if (!S.model || S.busy) return;
    setBusy(true, "正在运行 checkMesh…");
    try {
      const job = await post("/api/job", { kind: "checkmesh", name: S.name });
      const result = await pollJob(job.id);
      if (result.status === "error") throw new Error(result.message || "checkMesh 失败");
      const payload = result.result || {};
      S.meshLog = (payload.lines || []).join("\n");
      S.meshLogTitle = payload.log || "checkMesh";
      if (S.section === "mesh") renderProps();
      toast(payload.ok ? "Mesh OK" : "检查完成，请查看日志", payload.ok ? "ok" : "error", "checkMesh");
      await refreshModel({ silent: true });
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doRun(options = {}) {
    if (!S.model || S.busy) return;
    if (S.dirty) { toast("请先应用当前设置，再启动计算", "error"); return; }
    if (!options.skipPreflight) {
      const ready = await preflightGate();
      if (!ready) return;
    }
    const ranks = (S.model.run && S.model.run.ranks) || 1;
    const startFrom = (S.model.control && S.model.control.startFrom) || "latestTime";
    setBusy(true, `正在启动 ${ranks} 核计算…`);
    try {
      const res = await post("/api/run", { name: S.name, ranks, startFrom });
      toast(res.message || "求解已启动", "ok", "启动计算");
      S.wasRunning = true;
      await refreshModel({ silent: true });
      updateRunBadge();
      startPolling();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doStop() {
    if (!S.model || S.busy) return;
    const ok = await confirmDialog({
      title: "停止计算？",
      sub: "求解器会先收到 SIGINT，已写出的时间目录会保留。",
      okText: "停止计算",
      danger: true,
    });
    if (!ok) return;
    setBusy(true, "正在停止求解器…");
    try {
      const res = await post("/api/stop", { name: S.name });
      toast(res.message || "求解已停止", "ok", "停止计算");
      S.wasRunning = false;
      await refreshModel({ silent: true });
      updateRunBadge();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doParaview() {
    if (!S.model || S.busy) return;
    setBusy(true, "正在启动 ParaView…");
    try {
      const res = await post("/api/paraview", { name: S.name });
      toast(res.message || "ParaView 正在打开", "ok", "ParaView");
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doFolder() {
    if (!S.model || S.busy) return;
    try {
      const res = await post("/api/openfolder", { name: S.name });
      toast(res.path || "已打开算例目录", "ok", "资源管理器");
    } catch (err) {
      showError(err);
    }
  }

  // ------------------------------------------------------------------ //
  // 新建算例
  // ------------------------------------------------------------------ //

  async function openNewCase() {
    if (!S.templates) {
      try {
        const data = await api("/api/templates");
        S.templates = data.templates || [];
      } catch (err) {
        showError(err);
        return;
      }
    }
    if (!S.templates.length) { toast("没有可用模板", "error"); return; }
    const groups = {};
    S.templates.forEach((item) => {
      const key = item.kind === "existing" ? "现有算例" : (item.solver || "教程");
      (groups[key] = groups[key] || []).push(item);
    });
    const templateOptions = Object.entries(groups).map(([group, items]) => `
      <optgroup label="${esc(group)}">
        ${items.map((item) => `<option value="${esc(item.id)}" data-solver="${esc(item.solver || "")}">${esc(item.name)}</option>`).join("")}
      </optgroup>`).join("");
    const solvers = Array.from(new Set([...(S.model && S.model.solverOptions ? S.model.solverOptions : []),
      "incompressibleFluid", "compressibleFluid", "multiphaseEuler", "multiphaseVoF"]));
    const { box, close } = showModal(`
      <h2>新建算例</h2>
      <div class="modal-sub">从现有算例或 OpenFOAM 教程复制一份干净的设置。</div>
      <div class="form-section">
        <div class="grid-2">
          ${field("算例名称", `<input id="ncName" placeholder="case-01" autocomplete="off">`)}
          ${field("模板", `<select id="ncTemplate">${templateOptions}</select>`)}
        </div>
        <div class="grid-2">
          ${field("求解器", select("ncSolver", solvers, "incompressibleFluid"))}
          ${field("模拟类型", select("ncSim", [
            { value: "laminar", label: "laminar（层流）" },
            { value: "RAS", label: "RAS（雷诺平均）" },
            { value: "LES", label: "LES（大涡模拟）" },
          ], "laminar"))}
        </div>
        <div class="grid-3">
          ${field("结束时间 / s", `<input id="ncEnd" type="number" step="any" value="10">`)}
          ${field("时间步长 / s", `<input id="ncDt" type="number" step="any" value="0.001">`)}
          ${field("最大库朗数", `<input id="ncCo" type="number" step="any" value="0.8">`)}
        </div>
        <label class="check-row"><input id="ncMesh" type="checkbox" checked>复制后立即运行 blockMesh</label>
        <div id="ncErr"></div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" data-close>取消</button>
        <button class="btn-ok" id="ncCreate">创建算例</button>
      </div>`, { wide: true });
    if (!box) return;
    const templateSel = box.querySelector("#ncTemplate");
    const solverSel = box.querySelector("#ncSolver");
    templateSel.addEventListener("change", () => {
      const opt = templateSel.selectedOptions[0];
      const solver = opt && opt.dataset.solver;
      if (solver && Array.from(solverSel.options).some((o) => o.value === solver)) solverSel.value = solver;
    });
    const errBox = box.querySelector("#ncErr");
    const showErr = (text) => { errBox.innerHTML = `<div class="alert bad" style="white-space:pre-wrap">${esc(text)}</div>`; };
    const create = box.querySelector("#ncCreate");
    create.addEventListener("click", async () => {
      const name = box.querySelector("#ncName").value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        showErr("算例名称需以字母或数字开头，仅限字母、数字、点、下划线、短横线。");
        return;
      }
      const values = {
        name,
        template: templateSel.value,
        solver: solverSel.value,
        simulationType: box.querySelector("#ncSim").value,
        endTime: Number(box.querySelector("#ncEnd").value),
        deltaT: Number(box.querySelector("#ncDt").value),
        maxCo: Number(box.querySelector("#ncCo").value),
        runBlockMesh: box.querySelector("#ncMesh").checked,
      };
      if (!Number.isFinite(values.endTime) || values.endTime <= 0) { showErr("结束时间需要正数。"); return; }
      if (!Number.isFinite(values.deltaT) || values.deltaT <= 0) { showErr("时间步长需要正数。"); return; }
      create.disabled = true;
      create.textContent = "正在创建…";
      try {
        const res = await post("/api/create", { values });
        close();
        toast(`已创建 ${name}${res.warnings && res.warnings.length ? `（${res.warnings.length} 条提示）` : ""}`, "ok", "新建算例");
        await loadState();
        await selectCase(name, { force: true });
      } catch (err) {
        showErr(errorText(err));
        create.disabled = false;
        create.textContent = "创建算例";
      }
    });
  }

  // ------------------------------------------------------------------ //
  // 菜单与帮助
  // ------------------------------------------------------------------ //

  let MENU_NODE = null;

  function closeMenu() {
    if (MENU_NODE) { MENU_NODE.remove(); MENU_NODE = null; }
  }

  function openMenu(anchor, items) {
    closeMenu();
    const pop = document.createElement("div");
    pop.className = "menu-pop";
    items.forEach((item) => {
      if (item.sep) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        pop.appendChild(sep);
        return;
      }
      const btn = document.createElement("button");
      btn.textContent = item.label;
      btn.disabled = !!item.disabled;
      btn.addEventListener("click", () => { closeMenu(); item.action(); });
      pop.appendChild(btn);
    });
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(6, Math.min(rect.left, window.innerWidth - 230))}px`;
    pop.style.top = `${rect.bottom + 4}px`;
    MENU_NODE = pop;
  }

  function showHelp() {
    showModal(`
      <h2>OpenFOAM 工作台 · 模型设置</h2>
      <div class="modal-sub">Flow-3D 风格的本地前处理界面</div>
      <div class="modal-note">
        <p><b>视图操作</b>：左键拖动旋转，滚轮缩放，双击复位。单击 3D 网格边界或右上角图例，可直接打开该边界的条件设置。</p>
        <p><b>设置体检</b>：工具栏“设置体检”一次核对网格、时间、场文件、湍流和边界覆盖；错误项可一键跳转修复，启动计算前也会自动检查。</p>
        <p><b>工作流</b>：选择算例 → 修改模型/网格/边界 → 应用设置 → 生成网格 → 检查网格 → 设置体检 → 启动计算。</p>
        <p><b>快捷键</b>：Ctrl+S 保存当前分区；Esc 关闭弹窗。有未保存修改时，离开页面会弹出提醒。</p>
        <p><b>注意</b>：正在计算的算例不能修改设置；blockMesh 会覆盖已有网格和结果。</p>
      </div>
      <div class="modal-actions"><button class="btn-ok" data-close>关闭</button></div>`);
  }

  function showWarnings() {
    const warnings = (S.model && S.model.warnings) || [];
    if (!warnings.length) { toast("没有提示", "ok"); return; }
    showModal(`
      <h2>算例提示</h2>
      <div class="modal-sub">${esc(S.name)}</div>
      <div class="modal-note"><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>
      <div class="modal-actions"><button class="btn-ok" data-close>关闭</button></div>`);
  }

  // ------------------------------------------------------------------ //
  // 事件绑定与启动
  // ------------------------------------------------------------------ //

  function bindChrome() {
    const caseSel = $("caseSelect");
    if (caseSel) caseSel.addEventListener("change", async () => {
      const name = caseSel.value;
      if (!name || name === S.name) return;
      await selectCase(name);
    });
    const refresh = async () => {
      await loadState();
      if (S.name) await refreshModel();
      toast("已刷新", "ok");
    };
    if ($("refreshAll")) $("refreshAll").addEventListener("click", refresh);
    if ($("treeRefresh")) $("treeRefresh").addEventListener("click", refresh);
    if ($("newCaseBtn")) $("newCaseBtn").addEventListener("click", openNewCase);
    if ($("saveBtn")) $("saveBtn").addEventListener("click", () => saveSection());
    if ($("applyBtn")) $("applyBtn").addEventListener("click", () => saveSection());
    if ($("revertBtn")) $("revertBtn").addEventListener("click", async () => {
      if (!S.dirty) return;
      const ok = await confirmDialog({ title: "还原当前设置？", body: "右侧面板中尚未应用的输入会丢失。", okText: "还原" });
      if (!ok) return;
      clearDirty();
      renderProps();
    });
    if ($("blockMeshBtn")) $("blockMeshBtn").addEventListener("click", doBlockMesh);
    if ($("checkMeshBtn")) $("checkMeshBtn").addEventListener("click", doCheckMesh);
    if ($("preflightBtn")) $("preflightBtn").addEventListener("click", () => openPreflight());
    if ($("runBtn")) $("runBtn").addEventListener("click", doRun);
    if ($("stopBtn")) $("stopBtn").addEventListener("click", doStop);
    if ($("paraviewBtn")) $("paraviewBtn").addEventListener("click", doParaview);
    if ($("folderBtn")) $("folderBtn").addEventListener("click", doFolder);
    if ($("statusWarn")) $("statusWarn").addEventListener("click", showWarnings);
    const tree = $("tree");
    if (tree) tree.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-section]");
      if (btn) switchSection(btn.dataset.section);
    });
    const body = $("propsBody");
    if (body) {
      body.addEventListener("input", markDirty);
      body.addEventListener("change", markDirty);
    }
    $$("[data-menu]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.menu;
        if (name === "file") openMenu(btn, [
          { label: "新建算例…", action: openNewCase },
          { label: "打开运行监控", action: () => { location.href = "/"; } },
          { sep: true },
          { label: "刷新算例列表", action: refresh },
        ]);
        else if (name === "edit") openMenu(btn, [
          { label: "保存当前设置", action: () => saveSection(), disabled: !S.model },
          { label: "还原当前设置", action: () => { clearDirty(); renderProps(); }, disabled: !S.dirty },
        ]);
        else if (name === "view") openMenu(btn, [
          { label: "适应窗口", action: () => fitView() },
          { label: "复位视角", action: resetView },
        ]);
        else if (name === "model") openMenu(btn, [
          ...Object.entries(SECTIONS).map(([id, meta]) => ({
            label: meta.title, action: () => switchSection(id),
          })),
        ]);
        else if (name === "run") openMenu(btn, [
          { label: "设置体检…", action: () => openPreflight() },
          { sep: true },
          { label: "启动计算", action: doRun, disabled: !S.model || (S.model.run && S.model.run.running) },
          { label: "停止计算", action: doStop, disabled: !S.model || !(S.model.run && S.model.run.running) },
          { sep: true },
          { label: "生成网格", action: doBlockMesh, disabled: !S.model },
          { label: "检查网格", action: doCheckMesh, disabled: !S.model },
        ]);
        else if (name === "help") openMenu(btn, [
          { label: "使用说明与快捷键", action: showHelp },
          { label: "算例提示", action: showWarnings },
        ]);
      });
    });
    document.addEventListener("pointerdown", (event) => {
      if (MENU_NODE && !MENU_NODE.contains(event.target)) closeMenu();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveSection();
      }
      if (event.key === "Escape") {
        closeMenu();
        const root = $("modalRoot");
        if (root && !root.hidden) {
          root.hidden = true;
          if ($("modalBox")) $("modalBox").innerHTML = "";
        }
      }
    });
    window.addEventListener("resize", () => closeMenu());
    window.addEventListener("beforeunload", (event) => {
      if (!S.dirty && !S.dictDirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  function clock() {
    const el = $("statusClock");
    if (el) el.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }

  async function init() {
    bindChrome();
    initViewport();
    clock();
    setInterval(clock, 1000);
    const ok = await loadState();
    if (!ok) return;
    const params = new URLSearchParams(location.search);
    const wanted = params.get("case") || localStorage.getItem("ofm.case");
    const name = (wanted && S.cases.some((item) => item.name === wanted))
      ? wanted
      : (S.cases[0] && S.cases[0].name);
    if (name) await selectCase(name, { force: true });
    else {
      renderTree();
      renderViewport();
      renderProps();
      updateButtons();
      setStatus("没有算例，请点击“新建算例”", "");
    }
  }

  init();
})();

