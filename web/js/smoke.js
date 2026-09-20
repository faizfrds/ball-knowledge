/* Browser-level smoke logic (no deps). Runs when ?smoke=1, renders into #smoke-panel. */
export async function runSmoke(state) {
  const panel = document.getElementById("smoke-panel");
  panel.hidden = false;
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail });
  try {
    check("worklist renders 20 rows (or filtered set)", state.ranked.length > 0, `${state.ranked.length} rows`);
    check("ranks are sequential", state.ranked.every((r, i) => r.rank === i + 1));
    check("priority index is 0-100 and never called probability",
      state.ranked.every((r) => r.priorityIndex >= 0 && r.priorityIndex <= 100) && !/probabilit/i.test(document.body.innerHTML));
    check("review-needed rows flagged", state.ranked.some((r) => r.reviewNeeded?.needed));
    check("excluded tray populated with reasons",
      state.excluded.length > 0 && state.excluded.every((e) => e.reason));
    check("cache badge shows key", /CACHE (WARM|COLD) · [0-9a-f]{8}/.test(document.getElementById("cache-badge").textContent));
    check("receipt has latency + tokens", !!(state.receipt?.receipt?.latencyMs != null && state.receipt?.receipt?.inputTokens != null));
    check("as-of gate enforced (max 2026-08-31)", document.getElementById("asof-input").max === "2026-08-31");
    check("dossier four-state strip present", document.getElementById("four-state").children.length === 4);
    check("aria live regions present", !!document.getElementById("sr-progress") && !!document.getElementById("sr-alerts"));
    // interactive: open first dossier tab set
    const first = document.querySelector("#worklist-body tr");
    check("worklist rows keyboard-focusable", !!first && first.tabIndex === 0);
    const tabs = [...document.querySelectorAll("#dossier-tabs [role='tab']")];
    check("dossier has 5 tabs", tabs.length === 5);
  } catch (err) { checks.push({ name: "smoke harness", ok: false, detail: String(err) }); }
  const passed = checks.filter((c) => c.ok).length;
  panel.innerHTML = `<h2>Smoke: ${passed}/${checks.length} pass (mode ${state.mode})</h2><ul>${checks.map((c) =>
    `<li class="${c.ok ? "pass" : "fail"}">${c.ok ? "PASS" : "FAIL"} — ${c.name}${c.detail ? ` <span class="hint">${c.detail}</span>` : ""}</li>`).join("")}</ul>`;
  console.log(`[smoke] ${passed}/${checks.length} pass`, checks);
  return checks;
}
