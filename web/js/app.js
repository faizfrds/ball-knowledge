/* Giving Day Triage Board — app orchestrator. Plain ES module, no deps. */
import { probeApi, createWorklist, fetchWorklist, streamWorklist, fetchExplanation, fetchConstituentBundle, normalizeRow } from "./api.js";
import { buildMockRanked, buildMockExcluded, buildMockReceipt } from "./mock.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const AS_OF_MAX = "2026-08-31";
const DATASET_VERSION = "1.2";
const MODEL_VERSION = "priority-index-0.1";
const EVIDENCE_VERSION = "mock-1";

const RUBRIC_DEFAULTS = [
  { key: "recency", label: "Recency", weight: 4, threshold: "active ≤ 12mo", unknownPolicy: "downrank" },
  { key: "affinity", label: "Affinity", weight: 3, threshold: "≥ 1 activity", unknownPolicy: "flag" },
  { key: "capacity_signal", label: "Capacity signal (paid giving first)", weight: 2, threshold: "≥ $250 paid 5y", unknownPolicy: "downrank" },
  { key: "contactability", label: "Contactability", weight: 5, threshold: "deliverable / available", unknownPolicy: "exclude" },
];
const THRESHOLDS = {
  recency: ["active ≤ 12mo", "active ≤ 24mo", "any history"],
  affinity: ["≥ 1 activity", "≥ 2 activities", "any affiliation"],
  capacity_signal: ["≥ $250 paid 5y", "≥ $1k paid 5y", "any paid gift"],
  contactability: ["deliverable / available", "email deliverable", "either channel"],
};

const state = {
  mode: "mock", // live | mock
  caps: null,
  ranked: [],
  excluded: [],
  receipt: null,
  cacheKey: "…",
  cacheHit: false,
  jobId: null,
  jobStatus: "idle",
  jobTimers: [],
  selectedId: null,
  reviewOnly: false,
  evidenceSort: "rank",
  dossierTab: "whyperson",
  lastFocus: null,
  rubric: structuredClone(RUBRIC_DEFAULTS),
};

/* ---------- utils ---------- */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}
function srSay(id, msg) { $(id).textContent = ""; requestAnimationFrame(() => { $(id).textContent = msg; }); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ---------- read controls ---------- */
function readFilters() {
  return {
    affiliationTypes: $$('input[name="affiliation"]:checked').map((el) => el.value),
    classYearRange: [$("#class-min").value ? Number($("#class-min").value) : null, $("#class-max").value ? Number($("#class-max").value) : null],
    cities: $("#city-input").value ? [$("#city-input").value.trim()] : [],
    activityNames: $("#activity-select").value ? [$("#activity-select").value] : [],
    paidGiftSince: $("#paid-since").value || null,
    minPaidTotal: $("#min-paid").value ? Number($("#min-paid").value) : null,
    emailStatuses: $("#email-status").value ? [$("#email-status").value] : [],
    phoneStatus: $("#phone-status").value || null,
    assignedStaffIds: $("#staff-id").value ? [Number($("#staff-id").value)] : [],
    campaignType: $("#campaign-type").value,
  };
}
function buildPayload() {
  return {
    query: $("#query-input").value.trim(),
    asOf: $("#asof-input").value || AS_OF_MAX,
    filters: readFilters(),
    rubric: state.rubric.map(({ key, weight, threshold, unknownPolicy }) => ({ criterion: key, weight, threshold, unknownPolicy })),
    limit: 20,
    staffRole: $("#role-select").value,
  };
}
function computeCacheKey(payload) {
  return fnv1a(JSON.stringify({ dv: DATASET_VERSION, ev: EVIDENCE_VERSION, mv: MODEL_VERSION, ...payload }));
}

/* ---------- chips ---------- */
function renderChips() {
  const f = readFilters();
  const chips = [];
  f.affiliationTypes.forEach((a) => chips.push({ k: "affil", v: a, label: `affiliation: ${a}` }));
  if (f.classYearRange[0] || f.classYearRange[1]) chips.push({ k: "class", v: "class", label: `class ${f.classYearRange[0] ?? "…"}–${f.classYearRange[1] ?? "…"}` });
  f.cities.forEach((c) => chips.push({ k: "city", v: c, label: `city: ${c}` }));
  f.activityNames.forEach((a) => chips.push({ k: "activity", v: a, label: `activity: ${a}` }));
  if (f.paidGiftSince) chips.push({ k: "paidsince", v: f.paidGiftSince, label: `paid since ${f.paidGiftSince}` });
  if (f.minPaidTotal) chips.push({ k: "minpaid", v: String(f.minPaidTotal), label: `≥ $${f.minPaidTotal} paid` });
  const box = $("#active-chips");
  box.innerHTML = chips.length ? "" : '<span class="hint">No typed filters — full eligible population.</span>';
  chips.forEach((c) => {
    const s = document.createElement("span");
    s.className = "chip";
    s.innerHTML = `${esc(c.label)} <button type="button" aria-label="Remove filter ${esc(c.label)}">×</button>`;
    s.querySelector("button").addEventListener("click", () => clearFilter(c.k, c.v));
    box.appendChild(s);
  });
}
function clearFilter(k, v) {
  if (k === "affil") { const el = $(`input[name="affiliation"][value="${v}"]`); if (el) el.checked = false; }
  if (k === "class") { $("#class-min").value = ""; $("#class-max").value = ""; }
  if (k === "city") $("#city-input").value = "";
  if (k === "activity") $("#activity-select").value = "";
  if (k === "paidsince") $("#paid-since").value = "";
  if (k === "minpaid") $("#min-paid").value = "";
  renderChips();
}

/* ---------- rubric ---------- */
function renderRubric() {
  const box = $("#rubric-rows");
  box.innerHTML = "";
  const readOnly = $("#role-select").value !== "mgo";
  state.rubric.forEach((row) => {
    const div = document.createElement("div");
    div.className = "rubric-row";
    div.innerHTML = `
      <div class="rubric-top"><span class="rubric-name">${esc(row.label)}</span>
      <span class="rubric-weight">weight <b>${row.weight}</b> / 5</span></div>
      <label>Weight (rerank only)<input type="range" min="0" max="5" step="1" value="${row.weight}" data-w="${esc(row.key)}" aria-label="${esc(row.label)} weight" ${readOnly ? "disabled" : ""} /></label>
      <div class="rubric-ctl">
        <label>Threshold<select data-t="${esc(row.key)}" ${readOnly ? "disabled" : ""}>${THRESHOLDS[row.key].map((t) => `<option ${t === row.threshold ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
        <label>Unknown policy<select data-u="${esc(row.key)}" ${readOnly ? "disabled" : ""}>${["downrank", "flag", "exclude"].map((u) => `<option ${u === row.unknownPolicy ? "selected" : ""}>${u}</option>`).join("")}</select></label>
      </div>`;
    box.appendChild(div);
  });
  $$("input[data-w]", box).forEach((el) => el.addEventListener("change", () => {
    const row = state.rubric.find((r) => r.key === el.dataset.w);
    row.weight = Number(el.value);
    renderRubric();
    rerankOnly(`Weight ${row.label} → ${row.weight}: reranked, no rescore.`);
  }));
  $$("select[data-t]", box).forEach((el) => el.addEventListener("change", () => {
    const row = state.rubric.find((r) => r.key === el.dataset.t);
    row.threshold = el.value;
    rescoreCriterion(row.label);
  }));
  $$("select[data-u]", box).forEach((el) => el.addEventListener("change", () => {
    const row = state.rubric.find((r) => r.key === el.dataset.u);
    row.unknownPolicy = el.value;
    rescoreCriterion(row.label);
  }));
}
function rankPill(text) {
  const pill = $("#rank-mode-pill");
  pill.textContent = text; pill.hidden = false;
  clearTimeout(rankPill._t);
  rankPill._t = setTimeout(() => { pill.hidden = true; }, 4000);
}
function rerankOnly(note) {
  // Weight-only: deterministic local rerank of current rows (no rescore).
  const w = Object.fromEntries(state.rubric.map((r) => [r.key, r.weight]));
  state.ranked.forEach((row) => {
    const boost = row.criteria.reduce((acc, c) => acc + (typeof c.value === "number" ? c.value * (w[c.key] ?? 1) : 0), 0);
    row._rerankScore = row.priorityIndex + boost;
  });
  state.ranked.sort((a, b) => b._rerankScore - a._rerankScore).forEach((r, i) => { r.rank = i + 1; });
  state.cacheKey = computeCacheKey(buildPayload());
  paintCacheBadge();
  renderWorklist();
  rankPill("Reranked — weights only");
  $("#job-note").textContent = note;
}
function rescoreCriterion(label) {
  // Threshold / unknown-policy edit: show staged rescoring pill, then re-run.
  rankPill(`Rescoring ${label}…`);
  srSay("#sr-progress", `Rescoring criterion ${label}.`);
  run();
}

/* ---------- progress ---------- */
function setProgress(stage) {
  const order = ["filter", "score", "rank", "evidence"];
  $$("#progress li").forEach((li) => {
    const idx = order.indexOf(li.dataset.stage);
    const cur = order.indexOf(stage);
    li.classList.toggle("done", idx < cur);
    li.classList.toggle("active", idx === cur);
  });
  const labels = { filter: "Filtering eligible constituents…", score: "Scoring criteria…", rank: "Ranking top-20…", evidence: "Linking evidence…" };
  $("#progress-hint").textContent = labels[stage] ?? "";
  srSay("#sr-progress", labels[stage] ?? "");
}
function clearProgress() {
  $$("#progress li").forEach((li) => li.classList.remove("active", "done"));
  $("#progress-hint").textContent = "";
}
function cancelJob() {
  state.jobTimers.forEach(clearTimeout);
  state.jobTimers = [];
  state.jobStatus = "cancelled";
  $("#cancel-btn").disabled = true;
  $("#run-btn").disabled = false;
  $("#loading-state").hidden = true;
  $("#job-note").textContent = "Run cancelled. Last completed results (if any) remain below.";
  srSay("#sr-progress", "Run cancelled.");
}

/* ---------- run ---------- */
async function run() {
  if ($("#role-select").value !== "mgo") { toast("Annual Giving role is read-only in this demo."); return; }
  const asOf = $("#asof-input").value || AS_OF_MAX;
  if (asOf > AS_OF_MAX) { $("#asof-error").hidden = false; $("#asof-input").focus(); return; }
  $("#asof-error").hidden = true;
  cancelSilent();
  state.jobStatus = "running";
  $("#run-btn").disabled = true;
  $("#cancel-btn").disabled = false;
  $("#error-state").hidden = true;
  $("#empty-state").hidden = true;
  $("#loading-state").hidden = false;
  const payload = buildPayload();
  state.cacheKey = computeCacheKey(payload);
  state.cacheHit = false;
  paintCacheBadge();
  if (!state.caps) { try { state.caps = await probeApi(); } catch { state.caps = { health: null }; } paintMode(); }
  if (state.caps?.worklists) { await runLive(payload); }
  else { runMock(payload); }
}
function cancelSilent() { state.jobTimers.forEach(clearTimeout); state.jobTimers = []; }

async function runLive(payload) {
  setProgress("filter");
  $("#job-note").textContent = "Creating worklist job on the API…";
  const t0 = performance.now();
  try {
    const created = await createWorklist(payload);
    state.jobId = created.jobId ?? created.job_id ?? "live-job";
    const es = streamWorklist(state.jobId, (ev) => {
      if (ev.__streamError || ev.status === "complete" || ev.ranked) { pollLive(performance.now() - t0); es?.close?.(); return; }
      if (ev.progress?.stage) setProgress(mapStage(ev.progress.stage));
      if (Array.isArray(ev.ranked) && ev.ranked.length) {
        state.ranked = ev.ranked.map(normalizeRow);
        renderWorklist(true);
      }
    });
    if (!es) await pollLive(0, t0);
    else state.jobTimers.push(setTimeout(() => { es.close?.(); pollLive(performance.now() - t0); }, 12000));
  } catch (err) {
    // Engine endpoint failed mid-flight → fall back to mock, loudly.
    $("#job-note").textContent = `API job failed (${err.message}); showing mocked rows instead.`;
    runMock(payload);
  }
}
function mapStage(s) { return { filtering: "filter", scoring: "score", ranking: "rank", evidence: "evidence" }[s] ?? "filter"; }
async function pollLive(elapsedHint = 0, t0 = performance.now()) {
  try {
    const res = await fetchWorklist(state.jobId);
    state.mode = "live";
    state.ranked = (res.ranked ?? []).map(normalizeRow);
    state.excluded = res.excluded ?? [];
    state.receipt = { jobId: state.jobId, status: res.status, cache: res.cache, receipt: res.receipt, backtest: res.backtest, eligibleN: res.progress?.eligibleN };
    state.cacheHit = !!res.cache?.hit;
    if (res.cache?.key) state.cacheKey = res.cache.key;
    finishRun(performance.now() - t0);
  } catch (err) { showError(`Live poll failed: ${err.message}`, state.cacheKey); }
}

function runMock(payload) {
  state.mode = "mock";
  paintMode();
  const t0 = performance.now();
  const full = buildMockRanked(payload.asOf);
  const filtered = applyMockFilters(full, payload.filters);
  state.excluded = buildMockExcluded();
  state.ranked = [];
  renderWorklist(true);
  const stages = ["filter", "score", "rank", "evidence"];
  const batch = Math.ceil(filtered.length / 4);
  stages.forEach((stage, si) => {
    state.jobTimers.push(setTimeout(() => {
      if (state.jobStatus !== "running") return;
      setProgress(stage);
      const upto = filtered.slice(0, batch * (si + 1));
      state.ranked = upto.map((r, i) => ({ ...r, rank: i + 1, _provisional: si < 3 }));
      renderWorklist(true);
      $("#job-note").textContent = `${stage === "filter" ? "Screened 19,500" : stage === "score" ? `Scored ${upto.length * 214} criterion cells` : stage === "rank" ? `Ranked ${upto.length} of ${filtered.length}` : "Evidence linked"} · provisional rows stream in…`;
    }, 260 * (si + 1)));
  });
  state.jobTimers.push(setTimeout(() => {
    if (state.jobStatus !== "running") return;
    state.ranked = filtered.map((r) => ({ ...r, _provisional: false }));
    state.receipt = buildMockReceipt({ cacheKey: state.cacheKey, cacheHit: state.cacheHit, latencyMs: Math.round(performance.now() - t0), ranked: state.ranked });
    state.jobId = state.receipt.jobId;
    finishRun(performance.now() - t0);
  }, 260 * 5 + 120));
}

function applyMockFilters(rows, f) {
  let out = rows.slice();
  if (f.affiliationTypes.length) out = out.filter((r) => f.affiliationTypes.some((a) => r.primaryAffiliation.toLowerCase().includes(a.slice(0, 5))));
  if (f.cities.length) { const q = f.cities[0].toLowerCase(); out = out.filter((r) => r.city.toLowerCase().includes(q)); }
  if (f.activityNames.length && f.activityNames[0] === "Young Alumni Council") out = out.filter((r) => (r.classYear ?? 0) >= 2015);
  if (f.classYearRange[0]) out = out.filter((r) => (r.classYear ?? 9999) >= f.classYearRange[0]);
  if (f.classYearRange[1]) out = out.filter((r) => (r.classYear ?? -1) <= f.classYearRange[1]);
  if (f.minPaidTotal) out = out.filter((r) => (r._mock?.paidTotal ?? 0) >= f.minPaidTotal);
  return out;
}

function finishRun(latencyMs) {
  state.jobStatus = "complete";
  $("#run-btn").disabled = false;
  $("#cancel-btn").disabled = true;
  $("#loading-state").hidden = true;
  clearProgress();
  paintCacheBadge();
  renderWorklist();
  renderGates();
  renderReceipt();
  const n = state.ranked.length;
  const rev = state.ranked.filter((r) => r.reviewNeeded?.needed).length;
  $("#job-note").textContent = n
    ? `${state.mode === "live" ? "Live engine" : "Mocked"} run complete in ${Math.round(latencyMs)} ms · ${n} ranked · ${rev} need review · cache ${state.cacheKey.slice(0, 8)}.`
    : "";
  srSay("#sr-progress", n ? `Run complete. ${n} ranked, ${rev} need review.` : "Run complete. No eligible constituents.");
  if (!n) { $("#empty-state").hidden = false; $("#empty-detail").textContent = `0 eligible from ${(state.receipt?.screenedN ?? 19500).toLocaleString()} screened — the contactability gate removed the most. Try clearing it.`; }
  if (new URLSearchParams(location.search).has("smoke")) import("./smoke.js").then((m) => m.runSmoke(state));
}

/* ---------- badges / mode ---------- */
function paintCacheBadge() {
  $("#cache-badge").textContent = `CACHE ${state.cacheHit ? "WARM" : "COLD"} · ${state.cacheKey.slice(0, 8)}`;
}
function paintMode() {
  const b = $("#api-mode-badge");
  const live = !!(state.caps?.health && state.mode === "live");
  const mock = !state.caps?.health;
  b.dataset.mode = state.mode === "live" && state.caps?.health ? "live" : "mock";
  b.textContent = b.dataset.mode === "live" ? "API LIVE" : mock ? "API MOCK · engine landing" : "API MOCK · fallback";
  const banner = $("#mode-banner");
  if (b.dataset.mode === "mock") {
    banner.hidden = false; banner.dataset.mode = "mock";
    banner.textContent = state.caps?.health
      ? "Mocked rows: /api/health is reachable but /api/worklists is not implemented yet — tolerating missing engine fields."
      : "Mocked rows: API unreachable (run `npm run dev` for live constituent bundles) — dossier keeps evidence + missing-data display regardless.";
  } else { banner.hidden = true; }
}

/* ---------- worklist render ---------- */
function visibleRows() {
  let rows = state.ranked.slice();
  if (state.reviewOnly) rows = rows.filter((r) => r.reviewNeeded?.needed);
  if (state.evidenceSort === "evidence") rows = rows.slice().sort((a, b) => b.evidenceCompleteness - a.evidenceCompleteness);
  return rows;
}
function evDots(c) {
  const filled = Math.round(c * 5);
  return `<span class="ev-dots" title="Evidence completeness ${Math.round(c * 100)}%"><b>${"●".repeat(filled)}</b>${"○".repeat(5 - filled)} ${Math.round(c * 100)}%</span>`;
}
function actionPill(a) { return a === "review_needed" ? `<span class="pill pill-review">review_needed</span>` : `<span class="pill pill-action">${esc(a)}</span>`; }

function renderWorklist(provisional = false) {
  const rows = visibleRows();
  const tb = $("#worklist-body");
  tb.innerHTML = "";
  const cards = $("#worklist-cards");
  cards.innerHTML = "";
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (r._provisional || provisional) tr.classList.add("provisional");
    tr.tabIndex = 0;
    tr.dataset.id = r.constituentId;
    tr.setAttribute("aria-selected", String(state.selectedId === r.constituentId));
    tr.setAttribute("aria-label", `Rank ${r.rank}: ${r.displayName}, action ${r.action}, priority ${r.priorityIndex}`);
    tr.innerHTML = `
      <td class="rank-cell">${r.rank}${r._provisional ? ' <span class="pill pill-prov">Provisional</span>' : ""}</td>
      <td class="name-cell"><span class="who">${esc(r.displayName)}</span><br /><span class="sub">${esc(r.primaryAffiliation ?? "affiliation unknown")}${r.classYear ? ` · ’${String(r.classYear).slice(2)}` : ""} · ${esc(r.city ?? "city unknown")}</span></td>
      <td class="why-cell">${esc(r.whyNow)}</td>
      <td>${actionPill(r.action)}</td>
      <td><b>${r.priorityIndex}</b><span class="index-bar" aria-hidden="true"><i style="width:${r.priorityIndex}%"></i></span><span class="visually-hidden">priority index ${r.priorityIndex} of 100, rank only</span></td>
      <td>${evDots(r.evidenceCompleteness)}</td>
      <td>${r.reviewNeeded?.needed ? '<span class="pill pill-review" title="' + esc((r.reviewNeeded.reasons ?? []).join("; ")) + '">needs review</span>' : "—"}</td>`;
    tr.addEventListener("click", () => selectRow(r.constituentId, tr));
    tr.addEventListener("keydown", (ev) => rowKey(ev, i));
    tb.appendChild(tr);

    const li = document.createElement("li");
    li.className = "card";
    li.innerHTML = `<b>#${r.rank} <span style="font-family:Georgia,serif">${esc(r.displayName)}</span></b>${r._provisional ? ' <span class="pill pill-prov">Provisional</span>' : ""}<br />
      <span class="hint">${esc(r.primaryAffiliation ?? "")} · ${esc(r.city ?? "")}</span><br />${esc(r.whyNow)}<br />
      <span style="display:flex;gap:.4rem;margin-top:.35rem;flex-wrap:wrap">${actionPill(r.action)}<span class="pill">index ${r.priorityIndex}</span>${r.reviewNeeded?.needed ? '<span class="pill pill-review">needs review</span>' : ""}</span>`;
    li.tabIndex = 0; li.setAttribute("role", "button");
    li.addEventListener("click", () => selectRow(r.constituentId, li));
    li.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); selectRow(r.constituentId, li); } });
    cards.appendChild(li);
  });
  $("#review-count").textContent = String(state.ranked.filter((r) => r.reviewNeeded?.needed).length);
  $("#excluded-count").textContent = String(state.excluded.length);
  $("#mobile-count").textContent = String(state.ranked.length);
  const banner = $("#review-banner");
  const rev = state.ranked.filter((r) => r.reviewNeeded?.needed).length;
  if (rev && !state.reviewOnly) { banner.hidden = false; banner.textContent = `${rev} of ${state.ranked.length} need human review before contact (unknown thresholds, sparse evidence). Toggle “Review-needed only” to triage them.`; }
  else if (state.reviewOnly) { banner.hidden = false; banner.textContent = `Showing ${rows.length} review-needed rows. Unknown is first-class — nothing hidden.`; }
  else banner.hidden = true;
  if (!rows.length && state.jobStatus === "complete") { $("#empty-state").hidden = false; } else { $("#empty-state").hidden = state.ranked.length ? true : $("#empty-state").hidden; }
}
function rowKey(ev, i) {
  const rows = $$("#worklist-body tr");
  if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); rows[i].click(); }
  else if (ev.key === "ArrowDown") { ev.preventDefault(); rows[i + 1]?.focus(); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); rows[i - 1]?.focus(); }
}

/* ---------- dossier ---------- */
async function selectRow(id, el) {
  state.lastFocus = el ?? document.activeElement;
  state.selectedId = id;
  $$("#worklist-body tr").forEach((tr) => tr.setAttribute("aria-selected", String(Number(tr.dataset.id) === id)));
  const row = state.ranked.find((r) => r.constituentId === id);
  if (!row) return;
  renderDossier(row);
  if (matchMedia("(max-width: 767px)").matches) document.body.dataset.step = "dossier";
  $("#dossier-heading").focus?.();
  // Try to enrich from the API when available; tolerate absence.
  if (state.caps?.health) {
    try {
      const [expl, bundle] = await Promise.allSettled([
        fetchExplanation(id, $("#asof-input").value || AS_OF_MAX),
        fetchConstituentBundle(id, $("#asof-input").value || AS_OF_MAX),
      ]);
      if (expl.status === "fulfilled" && expl.value) { row._live = { ...row._live, explanation: expl.value }; renderDossier(row); }
      if (bundle.status === "fulfilled" && bundle.value) { row._live = { ...row._live, bundle: bundle.value }; renderDossier(row); }
    } catch { /* mock evidence stands */ }
  }
}
function criterionState(c) {
  if (c.state === "unknown") return '<span class="pill">unknown</span>';
  return c.state === "pass" ? '<span class="pill">pass</span>' : '<span class="pill">fail</span>';
}
function renderDossier(row) {
  $("#dossier-empty").hidden = true;
  const d = $("#dossier");
  d.hidden = false;
  $("#dossier-rank").textContent = `Rank ${row.rank} · constituent #${row.constituentId} · as-of ${$("#asof-input").value || AS_OF_MAX}`;
  $("#dossier-name").textContent = row.displayName;
  $("#dossier-meta").textContent = `${row.primaryAffiliation ?? "affiliation unknown"}${row.classYear ? ` · class ${row.classYear}` : ""} · ${row.city ?? "city unknown"}`;
  $("#four-state").innerHTML = `
    <div class="state-cell"><b>Eligible</b>${esc(row.eligibility)}</div>
    <div class="state-cell"><b>Priority index</b>${row.priorityIndex} / 100 · rank only</div>
    <div class="state-cell"><b>Evidence</b>${Math.round(row.evidenceCompleteness * 100)}% complete</div>
    <div class="state-cell" data-flag="${row.reviewNeeded?.needed ? "warn" : ""}"><b>Review</b>${row.reviewNeeded?.needed ? "needed" : "clear"}</div>`;
  const m = row._mock ?? {};
  const chipsFor = (ids) => (ids ?? []).map((id) => `<span class="ev-chip">${esc(id.replace(":", " #"))}</span>`).join(" ");
  const whyPerson = `
    <p>${esc(row.primaryAffiliation ?? "No affiliation on file")} · ${row.classYear ? `class of ${row.classYear}` : "degree year unknown"} · ${esc(row.city ?? "location unknown")}.</p>
    <p>Paid giving (5y, installments only): <b>$${(m.paidTotal ?? 0).toLocaleString()}</b> ${chipsFor([`gift:${m.giftId ?? "?"}`])} ${chipsFor([`interaction:${m.intId ?? "?"}`])}</p>
    ${row._live?.bundle ? `<p class="hint">Live bundle: <code>${esc(JSON.stringify(row._live.bundle.features ?? row._live.bundle).slice(0, 220))}…</code></p>` : ""}
    <p class="hint">Capacity cites recorded giving first; title/employer is weak context only (≤10%).</p>`;
  const whyNow = `<p>${esc(row.whyNow)}</p><p class="hint">Temporal trigger pinned to T0 ${esc($("#asof-input").value || AS_OF_MAX)}. Windows stated explicitly (e.g. “no paid gift in 3y as of T0”).</p>
    ${row._live?.explanation ? `<p class="hint">Live explanation: <code>${esc(JSON.stringify(row._live.explanation).slice(0, 220))}…</code></p>` : ""}`;
  const action = `
    <p>Permitted action: ${actionPill(row.action)}</p>
    <p>${esc(row.actionRationale)}</p>
    ${row.disallowedActions.length ? `<p>Disallowed: ${row.disallowedActions.map((a) => `<span class="disallowed">${esc(a)}</span>`).join(", ")}</p>` : `<p class="hint">No channel suppressions on this row.</p>`}
    ${row.reviewNeeded?.needed ? `<p><span class="pill pill-review">review_needed fallback</span> ${esc((row.reviewNeeded.reasons ?? []).join(" · "))}</p>` : ""}`;
  const evidence = `
    <ol class="timeline">
      <li><time>${esc(m.giftDate ?? "2026-08-01")}</time>Paid gift $${(m.paidTotal ?? 0).toLocaleString()} <span class="ev-chip">gift #${m.giftId ?? "?"}</span></li>
      <li><time>${esc(String(m.interactionAt ?? "2026-08-20").slice(0, 10))}</time>Outreach logged <span class="ev-chip">interaction #${m.intId ?? "?"}</span></li>
      <li><time>2026-05-14</time>Event attended <span class="ev-chip">attendance #${(row.constituentId % 400) + 31}</span></li>
    </ol>
    <p class="hint">Every reason links a row id (table:id). Pledged/pending gifts never count as paid.</p>`;
  const missing = row.missing?.length
    ? `<ul class="missing-list">${row.missing.map((x) => `<li><b>${esc(x.field)}</b> — ${esc(x.implication)}</li>`).join("")}</ul><p><button type="button" class="btn btn-ghost" id="research-btn">Log research task</button></p>`
    : `<p>All invoked criteria have linked evidence.</p>`;
  const panels = { whyperson: whyPerson, whynow: whyNow, action, evidence, missing };
  Object.entries(panels).forEach(([k, html]) => { $(`#panel-${k}`).innerHTML = html; });
  $("#research-btn")?.addEventListener("click", () => toast("Research task logged (demo — no backend write)."));
  activateTab(state.dossierTab);
}
function activateTab(name) {
  state.dossierTab = name;
  $$("#dossier-tabs [role='tab']").forEach((t) => {
    const on = t.id === `tab-${name}`;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $(`#${t.getAttribute("aria-controls")}`).hidden = !on;
  });
}

/* ---------- gates / receipt / excluded ---------- */
function renderGates() {
  const gates = { contactable: 11842, alive: 19310, suppressible: 18204, mgo: 11207 };
  Object.entries(gates).forEach(([k, v]) => {
    const el = $(`[data-gate="${k}"]`);
    if (el) { el.textContent = v.toLocaleString(); el.closest("li").dataset.pass = "true"; }
  });
}
function renderReceipt() {
  const r = state.receipt;
  if (!r) return;
  const rows = [
    ["job", r.jobId], ["status", r.status ?? state.jobStatus],
    ["dataset / evidence / model", `${r.datasetVersion ?? DATASET_VERSION} / ${r.evidenceVersion ?? EVIDENCE_VERSION} / ${r.modelVersion ?? MODEL_VERSION}`],
    ["as-of T0", r.asOf ?? $("#asof-input").value],
    ["eligible / screened", `${(r.eligibleN ?? 11842).toLocaleString()} / ${(r.screenedN ?? 19500).toLocaleString()}`],
    ["cache", `${r.cache?.hit ? "WARM" : "COLD"} · ${r.cache?.key ?? state.cacheKey}`],
    ["latency", `${r.receipt?.latencyMs ?? "?"} ms${r.cache?.uncachedMs ? ` (uncached ${r.cache.uncachedMs} ms${r.cache.warmMs ? ` / warm ${r.cache.warmMs} ms` : ""})` : ""}`],
    ["tokens in / out", `${r.receipt?.inputTokens ?? "?"} / ${r.receipt?.outputTokens ?? "?"}`],
    ["cost", r.receipt?.costUsd != null ? `$${r.receipt.costUsd}` : "n/a"],
  ];
  $("#receipt-grid").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $("#backtest-body").innerHTML = (r.backtest?.rows ?? []).map((x) => `<tr><td>${esc(x.metric)}</td><td>${esc(x.triage)}</td><td>${esc(x.baseline)}</td></tr>`).join("")
    + `<tr><td>T0 / window</td><td colspan="2">${esc(r.backtest?.t0 ?? "2025-08-31")} · ${esc(r.backtest?.window ?? "90d")}</td></tr>`;
}
function renderExcluded() {
  $("#excluded-list").innerHTML = state.excluded.map((e) => `<li><b>${esc(e.displayName)}</b> <span class="pill">${esc(e.reason)}</span><br /><span class="hint">${esc(e.detail ?? "")}</span></li>`).join("") || "<li>No exclusions recorded.</li>";
}
function openDialog(which) {
  state.lastFocus = document.activeElement;
  const drawer = $(`#${which}-drawer`), scrim = $(`#${which}-scrim`);
  if (which === "excluded") renderExcluded();
  if (which === "receipt") renderReceipt();
  drawer.hidden = false; scrim.hidden = false;
  if (matchMedia("(max-width: 767px)").matches && which === "receipt") document.body.dataset.step = "receipt";
  $(`#${which}-close-btn`).focus();
}
function closeDialog(which) {
  $(`#${which}-drawer`).hidden = true;
  $(`#${which}-scrim`).hidden = true;
  if (state.lastFocus?.focus) state.lastFocus.focus();
}

/* ---------- errors ---------- */
function showError(msg, cacheKey) {
  state.jobStatus = "failed";
  $("#loading-state").hidden = true;
  $("#run-btn").disabled = false;
  $("#cancel-btn").disabled = true;
  const box = $("#error-state");
  box.hidden = false;
  $("#error-detail").textContent = `${msg} · job ${state.jobId ?? "n/a"} · cache ${(cacheKey ?? state.cacheKey).slice(0, 8)}`;
  srSay("#sr-alerts", `Run failed. ${msg}`);
}

/* ---------- events ---------- */
function bind() {
  $("#run-btn").addEventListener("click", run);
  $("#cancel-btn").addEventListener("click", cancelJob);
  $("#retry-btn").addEventListener("click", run);
  $("#copy-diag-btn").addEventListener("click", async () => {
    const diag = JSON.stringify({ jobId: state.jobId, cacheKey: state.cacheKey, detail: $("#error-detail").textContent }, null, 2);
    try { await navigator.clipboard.writeText(diag); toast("Diagnostics copied."); } catch { toast("Clipboard blocked — select the error text manually."); }
  });
  ["query-input", "class-min", "class-max", "city-input", "activity-select", "paid-since", "min-paid", "email-status", "phone-status", "staff-id", "campaign-type"].forEach((id) => {
    $(`#${id}`)?.addEventListener("change", renderChips);
  });
  $$('input[name="affiliation"]').forEach((el) => el.addEventListener("change", renderChips));
  $("#asof-input").addEventListener("change", () => {
    const v = $("#asof-input").value;
    if (v && v > AS_OF_MAX) { $("#asof-error").hidden = false; }
    else { $("#asof-error").hidden = true; state.cacheKey = computeCacheKey(buildPayload()); paintCacheBadge(); }
  });
  $("#role-select").addEventListener("change", () => {
    renderRubric();
    $("#run-btn").disabled = $("#role-select").value !== "mgo";
    if ($("#role-select").value !== "mgo") toast("Annual Giving role: read-only demo — rubric and Run locked.");
  });
  $("#review-toggle").addEventListener("change", (e) => { state.reviewOnly = e.target.checked; renderWorklist(); });
  $("#evidence-sort").addEventListener("change", (e) => { state.evidenceSort = e.target.value; renderWorklist(); });
  $("#excluded-open-btn").addEventListener("click", () => openDialog("excluded"));
  $("#excluded-close-btn").addEventListener("click", () => closeDialog("excluded"));
  $("#excluded-scrim").addEventListener("click", () => closeDialog("excluded"));
  $("#empty-excluded-btn").addEventListener("click", () => openDialog("excluded"));
  $("#empty-clear-btn").addEventListener("click", () => { $("#email-status").value = ""; $("#phone-status").value = ""; renderChips(); run(); });
  $("#receipt-open-btn").addEventListener("click", () => openDialog("receipt"));
  $("#receipt-close-btn").addEventListener("click", () => closeDialog("receipt"));
  $("#receipt-scrim").addEventListener("click", () => closeDialog("receipt"));
  $("#copy-receipt-btn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(state.receipt, null, 2)); toast("Receipt JSON copied."); }
    catch { toast("Clipboard blocked in this browser."); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#receipt-drawer").hidden) closeDialog("receipt");
      else if (!$("#excluded-drawer").hidden) closeDialog("excluded");
      else if (document.body.classList.contains("rail-open")) document.body.classList.remove("rail-open");
      else if (document.body.dataset.step === "dossier") { document.body.dataset.step = "worklist"; state.lastFocus?.focus?.(); }
    }
  });
  // dossier tabs: click + arrow keys
  $$("#dossier-tabs [role='tab']").forEach((tab, i, tabs) => {
    tab.addEventListener("click", () => activateTab(tab.id.replace("tab-", "")));
    tab.addEventListener("keydown", (e) => {
      let n = null;
      if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
      if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
      if (n != null) { e.preventDefault(); tabs[n].focus(); activateTab(tabs[n].id.replace("tab-", "")); }
    });
  });
  $("#dossier-back-btn").addEventListener("click", () => { document.body.dataset.step = "worklist"; state.lastFocus?.focus?.(); });
  $("#rail-toggle").addEventListener("click", () => {
    const open = document.body.classList.toggle("rail-open");
    $("#rail-toggle").setAttribute("aria-expanded", String(open));
    if (matchMedia("(max-width: 767px)").matches) document.body.dataset.step = open ? "ask" : "worklist";
  });
  // mobile stepped tabs
  $$(".mobile-tabs button").forEach((btn) => btn.addEventListener("click", () => {
    $$(".mobile-tabs button").forEach((b) => b.setAttribute("aria-current", "false"));
    btn.setAttribute("aria-current", "page");
    const tab = btn.dataset.tab;
    document.body.classList.remove("rail-open");
    if (tab === "ask") document.body.dataset.step = "ask";
    else if (tab === "dossier") document.body.dataset.step = "dossier";
    else if (tab === "receipt") openDialog("receipt");
    else document.body.dataset.step = "worklist";
  }));
  if (matchMedia("(min-width: 768px)").matches) document.body.dataset.step = "worklist";
  else if (!document.body.dataset.step) document.body.dataset.step = "worklist";
}

/* ---------- init ---------- */
async function init() {
  // Non-code probe first: cheap capability check, never blocks first paint.
  renderChips();
  renderRubric();
  paintCacheBadge();
  bind();
  state.cacheKey = computeCacheKey(buildPayload());
  paintCacheBadge();
  try { state.caps = await probeApi(); } catch { state.caps = { health: null }; }
  paintMode();
  await run(); // auto-run so the board paints immediately (mock or live)
}

init();
