const EXAMPLE_NOTE = `Patient is a 62-year-old woman with a history of moderate-to-severe rheumatoid arthritis, inadequately controlled on methotrexate for the past 18 months. She has failed one prior TNF inhibitor (adalimumab) due to lack of efficacy. Current labs: ALT 28 U/L, AST 31 U/L, hemoglobin 12.1 g/dL, platelet count 240 x10^9/L, eGFR 78 mL/min/1.73m2. No history of tuberculosis or active infection. She is not pregnant. ECOG performance status 0. She is interested in trials of biologic or targeted synthetic DMARDs.`;

const EXAMPLE_DESIGN_QUERY = `Completed phase 3 trials in moderate-to-severe atopic dermatitis, with a placebo arm and an EASI-75 endpoint`;

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// ---- tabs ----
$all(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $all(".tab").forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    $all(".panel").forEach((p) => p.classList.remove("active"));
    $(`#panel-${tab.dataset.tab}`).classList.add("active");
  });
});

$("#load-example").addEventListener("click", () => { $("#patient-note").value = EXAMPLE_NOTE; });
$("#load-example-design").addEventListener("click", () => { $("#design-query").value = EXAMPLE_DESIGN_QUERY; });

function fmtNum(n, digits = 0) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
}
function fmtCost(n) {
  return n === null || n === undefined ? "n/a" : `$${Number(n).toFixed(4)}`;
}
function fmtSeconds(n) {
  return n === null || n === undefined ? "—" : `${Number(n).toFixed(2)}s`;
}

function renderReceipt(container, receipt) {
  container.hidden = false;
  container.innerHTML = `
    <h3>Cost receipt</h3>
    <dl>
      <dt>LLM tokens</dt><dd>${fmtNum(receipt.llm_tokens)}</dd>
      <dt>Jev tokens</dt><dd>${fmtNum(receipt.jev_tokens)}</dd>
      <dt>LLM calls</dt><dd>${fmtNum(receipt.llm_calls)}</dd>
      <dt>Jev calls</dt><dd>${fmtNum(receipt.jev_calls)}</dd>
      <dt>$ total</dt><dd>${fmtCost(receipt.total_cost_usd)}</dd>
      <dt>Time to first result</dt><dd>${fmtSeconds(receipt.time_to_first_result_s)}</dd>
      <dt>Wall clock</dt><dd>${fmtSeconds(receipt.wall_clock_s)}</dd>
    </dl>
  `;
}

function chip(label, value) {
  return `<span class="chip"><b>${label}</b>${value}</span>`;
}

// ---- Patient -> Trials ----
$("#run-match").addEventListener("click", async () => {
  const note = $("#patient-note").value.trim();
  if (!note) return;
  const button = $("#run-match");
  const status = $("#match-status");
  button.disabled = true;
  status.hidden = false;
  status.className = "status";
  status.textContent = "Reading patient note, retrieving, gating, and checking criteria… this can take a while at full 20k retrieval scale.";
  $("#match-results").innerHTML = "";
  $("#patient-rubric").hidden = true;

  try {
    const res = await fetch("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patient_note: note }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const data = await res.json();
    status.hidden = true;
    renderPatientRubric(data.patient);
    renderMatches(data.matches);
    renderReceipt($("#match-receipt"), data.receipt);
  } catch (err) {
    status.className = "status error";
    status.textContent = `Error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

function renderPatientRubric(patient) {
  const el = $("#patient-rubric");
  el.hidden = false;
  const labs = Object.entries(patient.labs || {}).map(([name, lab]) => `${name}=${lab.value}${lab.unit || ""}`).join(", ");
  el.innerHTML = [
    chip("Condition", patient.main_condition || "—"),
    chip("Age", patient.age_years ?? "—"),
    chip("Sex", patient.sex),
    patient.diagnoses?.length ? chip("Diagnoses", patient.diagnoses.join(", ")) : "",
    labs ? chip("Labs", labs) : "",
  ].join("");
}

function criterionItem(cr) {
  const verdict = cr.verdict;
  return `<li>
    <span class="kind">${cr.criterion.kind}</span>
    <span class="verdict ${verdict}">${verdict.replace(/_/g, " ")}</span>
    <span class="via">(${cr.evaluated_by})</span>
    <div>${escapeHtml(cr.criterion.text)}</div>
  </li>`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function renderMatches(matches) {
  const container = $("#match-results");
  if (!matches.length) {
    container.innerHTML = `<p class="status">No eligible or excluded trials found above threshold.</p>`;
    return;
  }
  container.innerHTML = matches
    .map((m, i) => {
      const nonMeets = (m.criterion_results || []).filter((cr) => cr.verdict !== "meets");
      const flagged = (m.criterion_results || []).filter((cr) => cr.verdict === "not_stated").length;
      return `
      <div class="card">
        <div class="card-head">
          <div>
            <span class="badge ${m.label}">${m.label.replace("_", " ")}</span>
            <span class="card-title"><a href="${m.trial.url}" target="_blank" rel="noopener">${i + 1}. ${escapeHtml(m.trial.title)}</a></span>
          </div>
          <span class="card-score">${m.trial.nct_id} · score ${Number(m.rank_score).toFixed(3)}${flagged ? ` · ${flagged} not stated` : ""}</span>
        </div>
        ${m.explanation ? `<p class="explanation">${escapeHtml(m.explanation)}</p>` : ""}
        ${
          (m.criterion_results || []).length
            ? `<button class="criteria-toggle" type="button">Show ${m.criterion_results.length} criteria (${nonMeets.length} flagged) ▾</button>
               <ul class="criteria-list">${m.criterion_results.map(criterionItem).join("")}</ul>`
            : ""
        }
      </div>`;
    })
    .join("");

  $all(".criteria-toggle", container).forEach((btn) => {
    btn.addEventListener("click", () => {
      const list = btn.nextElementSibling;
      list.classList.toggle("open");
      btn.textContent = btn.textContent.replace(/[▾▴]/, list.classList.contains("open") ? "▴" : "▾");
    });
  });
}

// ---- Design Benchmarking ----
$("#run-design").addEventListener("click", async () => {
  const query = $("#design-query").value.trim();
  if (!query) return;
  const button = $("#run-design");
  const status = $("#design-status");
  button.disabled = true;
  status.hidden = false;
  status.className = "status";
  status.textContent = "Parsing the design query, filtering, and judging endpoint/population/design match…";
  $("#design-results").innerHTML = "";
  $("#design-rubric").hidden = true;
  $("#enrollment-chart").hidden = true;

  try {
    const res = await fetch("/api/design", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const data = await res.json();
    status.hidden = true;
    renderDesignRubric(data.query, data.n_candidates, data.matches.length);
    renderEnrollmentChart(data.enrollment_stats);
    renderDesignMatches(data.matches);
    renderReceipt($("#design-receipt"), data.receipt);
  } catch (err) {
    status.className = "status error";
    status.textContent = `Error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

function renderDesignRubric(query, nCandidates, nMatched) {
  const el = $("#design-rubric");
  el.hidden = false;
  el.innerHTML = [
    query.phase ? chip("Phase", query.phase) : "",
    query.status ? chip("Status", query.status) : "",
    query.condition_keywords?.length ? chip("Condition", query.condition_keywords.join(", ")) : "",
    query.population_description ? chip("Population", query.population_description) : "",
    query.design_requirements?.length ? chip("Design", query.design_requirements.join(", ")) : "",
    query.endpoint_description ? chip("Endpoint", query.endpoint_description) : "",
    chip("Matched", `${nMatched} / ${nCandidates} code-filtered`),
  ].join("");
}

function renderDesignMatches(matches) {
  const container = $("#design-results");
  if (!matches.length) {
    container.innerHTML = `<p class="status">No trials matched all design requirements.</p>`;
    return;
  }
  container.innerHTML = matches
    .map((m) => {
      const probs = Object.entries(m.probabilities || {}).map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(", ");
      return `
      <div class="card">
        <div class="card-head">
          <span class="card-title"><a href="${m.trial.url}" target="_blank" rel="noopener">${escapeHtml(m.trial.title)}</a></span>
          <span class="card-score">${m.trial.nct_id} · enrollment ${m.trial.enrollment ?? "—"}</span>
        </div>
        <p class="explanation">${probs}</p>
      </div>`;
    })
    .join("");
}

function renderEnrollmentChart(stats) {
  const el = $("#enrollment-chart");
  if (!stats || !stats.values || !stats.values.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const values = stats.values;
  const bins = 12;
  const min = stats.min, max = stats.max;
  const width = Math.max(1, max - min);
  const counts = new Array(bins).fill(0);
  values.forEach((v) => {
    const idx = Math.min(bins - 1, Math.floor(((v - min) / width) * bins));
    counts[idx]++;
  });
  const maxCount = Math.max(...counts);
  const barWidth = 100 / bins;
  const bars = counts
    .map((c, i) => {
      const h = maxCount ? (c / maxCount) * 80 : 0;
      return `<rect x="${i * barWidth + 0.5}" y="${90 - h}" width="${barWidth - 1}" height="${h}" fill="#b5461f" />`;
    })
    .join("");

  el.innerHTML = `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none">${bars}<line x1="0" y1="90" x2="100" y2="90" stroke="#e4e3dd" /></svg>
    <div class="chart-stats">
      <span><b>${stats.n}</b> matched trials with enrollment data</span>
      <span>min <b>${fmtNum(stats.min)}</b></span>
      <span>p25 <b>${fmtNum(stats.p25)}</b></span>
      <span>median <b>${fmtNum(stats.median)}</b></span>
      <span>mean <b>${fmtNum(stats.mean)}</b></span>
      <span>p75 <b>${fmtNum(stats.p75)}</b></span>
      <span>max <b>${fmtNum(stats.max)}</b></span>
    </div>
  `;
}
