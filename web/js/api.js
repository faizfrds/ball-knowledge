/* API client — consumes the worklist contract, tolerates the engine landing later. No deps. */

const JSON_HEADERS = { "content-type": "application/json" };

async function getJSON(url, { timeoutMs = 6000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function postJSON(url, body, { timeoutMs = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

/** Probe what the server actually serves. Never throws — returns capability flags. */
export async function probeApi() {
  const caps = { health: null, worklists: false, explanation: false, constituentBundle: false };
  try {
    caps.health = await getJSON("/api/health", { timeoutMs: 3000 });
  } catch { caps.health = null; return caps; }
  try { await getJSON("/api/constituents?limit=1", { timeoutMs: 3000 }); caps.constituentBundle = true; } catch { /* optional */ }
  // Engine endpoints land later; a 404 here simply means "mock mode".
  try {
    await postJSON("/api/worklists", { probe: true });
    caps.worklists = true;
  } catch { caps.worklists = false; }
  return caps;
}

export async function createWorklist(payload) {
  return postJSON("/api/worklists", payload);
}

export async function fetchWorklist(jobId, include = "excluded") {
  return getJSON(`/api/worklists/${encodeURIComponent(jobId)}?include=${include}`);
}

/** SSE stream with graceful fallback: resolves null when unsupported so caller polls/fakes progress. */
export function streamWorklist(jobId, onEvent) {
  if (typeof EventSource === "undefined") return null;
  try {
    const es = new EventSource(`/api/worklists/${encodeURIComponent(jobId)}/stream`);
    es.onmessage = (ev) => { try { onEvent(JSON.parse(ev.data)); } catch { /* ignore malformed */ } };
    es.onerror = () => { es.close(); onEvent({ __streamError: true }); };
    return es;
  } catch { return null; }
}

export async function fetchExplanation(constituentId, asOf) {
  return getJSON(`/api/constituents/${encodeURIComponent(constituentId)}/explanation?asOf=${encodeURIComponent(asOf)}`);
}

export async function fetchConstituentBundle(constituentId, asOf) {
  return getJSON(`/api/constituents/${encodeURIComponent(constituentId)}?asOf=${encodeURIComponent(asOf)}`);
}

/** Normalize a server RankedRow: missing fields get safe defaults (engine tolerance). */
export function normalizeRow(raw, i) {
  return {
    rank: raw.rank ?? i + 1,
    constituentId: raw.constituentId ?? raw.constituent_id ?? raw.id ?? -1,
    displayName: raw.displayName ?? raw.display_name ?? `Constituent ${raw.constituentId ?? "?"}`,
    primaryAffiliation: raw.primaryAffiliation ?? raw.primary_affiliation ?? null,
    classYear: raw.classYear ?? raw.class_year ?? null,
    city: raw.city ?? null,
    eligibility: raw.eligibility ?? "eligible",
    priorityIndex: typeof raw.priorityIndex === "number" ? raw.priorityIndex : 0,
    action: raw.action ?? "review_needed",
    actionRationale: raw.actionRationale ?? raw.action_rationale ?? "No rationale returned — treated as review-needed until the engine lands.",
    disallowedActions: raw.disallowedActions ?? raw.disallowed_actions ?? [],
    whyNow: raw.whyNow ?? raw.why_now ?? "Why-now not returned by engine yet.",
    evidenceCompleteness: typeof raw.evidenceCompleteness === "number" ? raw.evidenceCompleteness : 0,
    reviewNeeded: raw.reviewNeeded ?? raw.review_needed ?? { needed: (raw.action ?? "") === "review_needed", reasons: [] },
    criteria: Array.isArray(raw.criteria) ? raw.criteria : [],
    missing: Array.isArray(raw.missing) ? raw.missing : [],
  };
}
