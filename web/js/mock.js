/* Deterministic mock worklist (engine-not-yet-landed fallback). No deps. */

const FIRST = ["Maya", "Daniel", "Priya", "Samuel", "Elena", "Marcus", "Aisha", "Thomas", "Grace", "Oliver",
  "Nadia", "Henry", "Clara", "James", "Ruth", "Victor", "Lena", "Paul", "Iris", "Noah",
  "Sofia", "Ellis", "June", "Omar"];
const LAST = ["Alvarez", "Okafor", "Raman", "Whitfield", "Petrova", "Bell", "Haddad", "Calloway", "Nguyen", "Hart",
  "Reyes", "Ashford", "Lindqvist", "Moreau", "Kaplan", "Duarte", "Fischer", "Abara", "Solberg", "Quinn"];
const AFFIL = ["Alumni · B.A.", "Alumni · B.S.", "Parent", "Friend", "Alumni · A.B.", "Trustee"];
const CITY = ["Boston, MA", "New York, NY", "Chicago, IL", "San Francisco, CA", "Austin, TX", "Philadelphia, PA"];
const WHY = [
  "Paid $500 on 2026-08-12 with no acknowledgement logged — thank within Giving Day window.",
  "Overdue follow-up from 2026-07-28 solicitation meeting with no later contact.",
  "Reunion year (class of 2016, 10th) plus 2 events attended in last 2 years.",
  "Promotion recorded 2026-07-30 (weak capacity context) after 4 paid gifts in 5y.",
  "Giving Day match active in donor metro; last paid gift 2026-06-02.",
  "Lapsed donor: no paid gift in 3y as of 2026-08-31 but 3 connected interactions last year.",
  "Invite window: future founders reception 2026-09-12 in donor city, reachable.",
  "Pledged $2,500 installment plan with first paid installment — steward before ask.",
  "Re-engaged after 18-month silence: replied 2026-08-20, reunion committee member.",
  "Consecutive giver 5y running; last gift 45 days ago — qualify for leadership ask review.",
];
const ACTIONS = ["thank", "invite", "cultivate", "qualify", "solicit", "research", "review_needed"];

/** mulberry32 — tiny seeded PRNG so mocks are stable across reloads. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }

export function buildMockRanked(asOf, seed = 260904) {
  const r = rng(seed);
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const fn = FIRST[i % FIRST.length]; const ln = LAST[(i * 7 + 3) % LAST.length];
    const affil = pick(r, AFFIL);
    const classYear = affil.startsWith("Parent") || affil === "Friend" ? null : 1992 + Math.floor(r() * 32);
    const city = pick(r, CITY);
    const priorityIndex = Math.round(96 - i * 2.4 - r() * 3);
    const review = i === 6 || i === 13 || i === 17;
    const action = review ? "review_needed" : ACTIONS[Math.floor(r() * 6)];
    const completeness = Math.round((0.45 + r() * 0.55) * 100) / 100;
    const paidTotal = Math.round((250 + r() * 12000) * 100) / 100;
    const whyNow = WHY[i % WHY.length];
    const cid = 1000 + i * 37;
    const giftId = 5000 + i * 11;
    const intId = 9000 + i * 13;
    rows.push({
      rank: i + 1,
      constituentId: cid,
      displayName: `${fn} ${ln}`,
      primaryAffiliation: affil,
      classYear,
      city,
      eligibility: "eligible",
      priorityIndex,
      action,
      actionRationale: action === "thank"
        ? "Paid gift in last 90d with no acknowledgement interaction logged."
        : action === "review_needed"
          ? "Conflicting or sparse evidence — human review before any contact."
          : `Permitted under as-of ${asOf} channel rules; see Action tab.`,
      disallowedActions: i % 5 === 0 ? ["solicit (email: do_not_email — phone only)"] : [],
      whyNow,
      evidenceCompleteness: completeness,
      reviewNeeded: review
        ? { needed: true, reasons: i === 6 ? ["sparse notes (made call only)", "missing phone"] : i === 13 ? ["stretch-ask pattern under review", "career overlap conflict"] : ["legacy designation (unmapped raw_fund_name)", "no lat/long"] }
        : { needed: false, reasons: [] },
      criteria: [
        { key: "recency", value: +(0.3 + r() * 0.7).toFixed(2), state: "pass", evidenceIds: [`gift:${giftId}`] },
        { key: "affinity", value: +(0.2 + r() * 0.8).toFixed(2), state: r() > 0.15 ? "pass" : "unknown", evidenceIds: ["activity:Alumni Association"] },
        { key: "capacity_signal", value: +(0.2 + r() * 0.6).toFixed(2), state: "pass", evidenceIds: [`gift:${giftId}`] },
        { key: "contactability", value: 1, state: "pass", evidenceIds: [`interaction:${intId}`] },
      ],
      missing: completeness < 0.6
        ? [{ field: "phone", implication: "Phone channel unavailable — email only." }, { field: "degree year", implication: "Reunion math unverified." }]
        : [{ field: "lat/long", implication: "Aggregate metro only; no precise map." }],
      _mock: {
        paidTotal, giftId, intId,
        giftDate: `2026-0${1 + (i % 8)}-${10 + (i % 17)}`,
        interactionAt: `2026-0${1 + ((i + 3) % 8)}-0${1 + (i % 8)}T14:00:00Z`,
      },
    });
  }
  return rows;
}

export function buildMockExcluded() {
  return [
    { constituentId: 4242, displayName: "Excluded — deceased record", reason: "deceased", detail: "constituents.deceased=true; historical giving retained but never ranked." },
    { constituentId: 4243, displayName: "Excluded — do-not-solicit", reason: "do_not_solicit", detail: "Suppression flag set; research-only, no contact actions." },
    { constituentId: 4244, displayName: "Excluded — uncontactable", reason: "uncontactable", detail: "email_status=missing and phone_status=missing as of T0." },
    { constituentId: 4245, displayName: "Excluded — inactive staff", reason: "inactive_staff", detail: "assigned staff record inactive; needs reassignment." },
    { constituentId: 4246, displayName: "Excluded — organization", reason: "organization", detail: "entity_type=organization; person worklist only." },
  ];
}

export function buildMockReceipt({ cacheKey, cacheHit, latencyMs, ranked }) {
  const hits = ranked.filter((r) => r.action === "thank").length;
  return {
    jobId: `mock-${cacheKey.slice(0, 8)}`,
    status: "complete",
    asOf: "2026-08-31",
    datasetVersion: "1.2",
    evidenceVersion: "mock-1",
    modelVersion: "priority-index-0.1",
    cache: { hit: cacheHit, key: cacheKey, uncachedMs: 1840, warmMs: cacheHit ? latencyMs : undefined },
    receipt: { inputTokens: 1240, outputTokens: 3860, costUsd: 0.0041, latencyMs },
    eligibleN: 11842,
    screenedN: 19500,
    backtest: {
      t0: "2025-08-31", window: "90d",
      rows: [
        { metric: "hit-rate@20", triage: `${hits}/20`, baseline: "9/20" },
        { metric: "total paid $ (W)", triage: "$48,210", baseline: "$41,905" },
        { metric: "median paid $ / hit", triage: "$500", baseline: "$450" },
      ],
    },
  };
}
