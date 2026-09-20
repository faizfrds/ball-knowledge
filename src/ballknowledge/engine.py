#!/usr/bin/env python3
"""The pipeline: route -> compile -> retrieve -> gate -> score -> rank -> explain.

The shape of the whole system is that no model ever reads the pile. The LLM sees the
query and, at the end, twenty titles. Jev sees one item at a time (or 25 packed into
an array). Code does every count, threshold and sort.
"""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import duckdb

from .domain import Domain, get as get_domain
from .jev import JevClient, p_true
from .rubric import LLMUsage, Rubric, compile_rubric, explain
from .sanitize import clean_query, filter_filters

PACK = 25          # items per gate request; see benchmark.json for the accuracy cost
GATE_PASS = 0.5    # floor on the COMBINED gate score (geometric mean, see below)
FULL_RUBRIC_MAX = 600
MIN_POOL = 200     # below this, a compiler-invented filter is doing more harm than good

# Jev allows 1,200 requests/min (20/s). At ~2.8 s per packed request, 12 workers use
# about 5% of that. 40 keeps us under the limit with room for retries.
GATE_WORKERS = 40
# Retrieval order is already good, so survivors concentrate in the first candidates.
# Gating in waves and stopping once enough have passed turns a fixed 8,000-item cost
# into a cost proportional to how hard the query actually is.
WAVE = 1500
ENOUGH = 150       # survivors after which further waves cannot change the top 20
# Blending the fused retrieval rank into the final score was tried and does not work.
# A 5-query sweep suggested w=0.4 lifted P@10 from 0.660 to 0.720, but on the full
# 20-query set the same setting LOWERED nDCG from 0.856 to 0.824 -- the sweep was
# underpowered and its apparent gain was noise. Default is 0: rubric score only.
RETRIEVAL_WEIGHT = float(os.environ.get("BK_RETRIEVAL_WEIGHT", "0.0"))


@dataclass
class Receipt:
    """Everything the cost story runs on; surfaced in the UI under each result set."""
    query: str = ""
    stages: dict[str, float] = field(default_factory=dict)
    candidates: int = 0
    gated: int = 0
    scored: int = 0
    jev: dict = field(default_factory=dict)
    llm: dict = field(default_factory=dict)
    gate_relaxed: bool = False
    judged: int = 0
    filters_dropped: list = field(default_factory=list)
    filters_rejected: list = field(default_factory=list)

    @property
    def total_cost(self) -> float:
        return self.jev.get("cost_usd", 0) + self.llm.get("cost_usd", 0)

    def as_dict(self) -> dict:
        return {"query": self.query, "stages_seconds": self.stages,
                "candidates": self.candidates, "passed_gate": self.gated,
                "fully_scored": self.scored, "judged": self.judged,
                "jev": self.jev, "llm": self.llm,
                "gate_relaxed": self.gate_relaxed,
                "filters_dropped": self.filters_dropped,
                "filters_rejected": self.filters_rejected,
                "total_cost_usd": round(self.total_cost, 6)}


class Engine:
    def __init__(self, db: str | None = None, processed: str | None = None,
                 domain: Domain | str = "works"):
        self.domain = get_domain(domain) if isinstance(domain, str) else domain
        self.db = db or self.domain.db
        self.processed = processed or self.domain.processed
        self._index = None
        self._columns: set[str] | None = None

    @property
    def index(self):
        if self._index is None:
            from .index import HybridIndex
            idx = HybridIndex.load(self.processed)
            self._verify_index(idx)
            self._index = idx
        return self._index

    def _verify_index(self, idx) -> None:
        """Refuse an index built from a different corpus.

        The vectors and the database are separate files, so nothing structural stops
        one domain's embeddings sitting next to another's rows. A sample of ids is
        checked against the table: if they do not belong, searching would return
        fluent, confidently wrong results rather than an error.
        """
        sample = idx.ids[:: max(len(idx.ids) // 50, 1)][:50]
        if not sample:
            raise RuntimeError(f"{self.domain.name}: index at {self.processed} is empty")
        con = self.con()
        found = con.execute(
            f"SELECT count(*) FROM {self.domain.table} "
            f"WHERE {self.domain.id_col} IN ?", [sample]).fetchone()[0]
        con.close()
        if found < len(sample) * 0.9:
            raise RuntimeError(
                f"{self.domain.name}: the index at {self.processed} does not match "
                f"{self.db} -- only {found}/{len(sample)} sampled ids exist in "
                f"{self.domain.table}. Rebuild it with "
                f"`scripts/index_domain.py --domain {self.domain.name}`.")

    def con(self):
        return duckdb.connect(self.db, read_only=True)

    @property
    def columns(self) -> set[str]:
        """The real column names, read from the database rather than kept by hand."""
        if self._columns is None:
            c = self.con()
            self._columns = {r[1].lower() for r in
                             c.execute(f"PRAGMA table_info('{self.domain.table}')").fetchall()}
            c.close()
        return self._columns

    def search(self, query: str, top_k: int = 20, pool: int = 20_000,
               rubric: Rubric | None = None, retrieval_weight: float | None = None,
               on_progress: Callable[[str, dict], None] | None = None) -> dict:
        w_ret = RETRIEVAL_WEIGHT if retrieval_weight is None else retrieval_weight
        query = clean_query(query)
        r = Receipt(query=query)
        llm_usage = LLMUsage()
        t = time.time()

        if rubric is None:
            rubric = compile_rubric(query, llm_usage,
                                    schema=self.domain.schema_desc)
        r.stages["compile"] = round(time.time() - t, 2)
        if on_progress:
            on_progress("rubric", rubric.as_dict())

        # 1. Hard filters first: SQL is free and shrinks everything downstream.
        # The compiler is an LLM and its output lands in a WHERE clause, so every
        # fragment is checked against a column/function allowlist before it runs.
        t = time.time()
        safe, refused = filter_filters(rubric.filters, self.columns)
        if refused:
            r.filters_rejected = refused
            rubric.filters = safe
        con = self.con()
        where = " AND ".join(f"({f})" for f in rubric.filters) or "TRUE"
        try:
            allow = {w for (w,) in con.execute(
                f"SELECT {self.domain.id_col} FROM {self.domain.table} WHERE {where}"
            ).fetchall()}
        except Exception:
            # A filter the compiler invented against a column that does not exist
            # should degrade to no filter, not to a failed query.
            allow = set()
        if len(allow) < MIN_POOL:
            # The compiler writes filters from a schema description, not from the
            # data, so it can invent a predicate that matches almost nothing
            # ("field = 'Quantum Physics'"). Retrieval over a gutted pool is worse
            # than retrieval with no filter at all.
            r.filters_dropped = rubric.filters
            rubric.filters = []
            allow = {w for (w,) in con.execute(
                f"SELECT {self.domain.id_col} FROM {self.domain.table}").fetchall()}
        r.stages["filter"] = round(time.time() - t, 2)

        # 2. Retrieval, fused across every phrasing.
        t = time.time()
        cand_ids = self.index.search(rubric.phrasings or [query], top_k=pool, allow=allow)
        r.candidates = len(cand_ids)
        r.stages["retrieve"] = round(time.time() - t, 2)
        if on_progress:
            on_progress("retrieved", {"candidates": r.candidates})

        if not cand_ids:
            con.close()
            return {"results": [], "rubric": rubric.as_dict(), "receipt": r.as_dict()}

        rows = {w: dict(zip([d[0] for d in con.description], vals)) for w, vals in
                ((v[0], v) for v in con.execute(
                    f"SELECT {', '.join(self.domain.select_cols)} "
                    f"FROM {self.domain.table} "
                    f"WHERE {self.domain.id_col} IN ?", [cand_ids]).fetchall())}
        con.close()
        cand_ids = [w for w in cand_ids if w in rows]
        # Position in the fused retrieval ranking, kept for the final blend.
        ret_rank = {w: i for i, w in enumerate(cand_ids)}

        jev = JevClient(workers=GATE_WORKERS)
        gate_fields = (sorted({f for g in rubric.gates for f in g.get("fields", [])})
                       or self.domain.default_fields)

        # 3. Gate: the must-haves, over every candidate.
        t = time.time()
        gate_qs = rubric.jev_questions(include_scores=False)
        if gate_qs:
            gate_p = {}
            judged: list[str] = []
            for start in range(0, len(cand_ids), WAVE):
                wave = cand_ids[start:start + WAVE]
                texts = [self.domain.format_item(rows[w], gate_fields) for w in wave]
                answers = jev.judge_packed(texts, gate_qs, per_request=PACK)
                judged.extend(wave)
                for w, ans in zip(wave, answers):
                    ps = [p_true(a) for a in ans.values()]
                    # Geometric mean, not the raw product: three independent gates at
                    # 0.7 multiply to 0.34 and fail a 0.5 threshold, rejecting a
                    # document that satisfies every gate reasonably well. The mean
                    # keeps "all must hold" (one zero still zeroes it) without
                    # penalising a document for being judged on more criteria.
                    gate_p[w] = (math.prod(ps) ** (1.0 / len(ps))) if ps else 1.0
                passed = sum(1 for w in judged if gate_p[w] >= GATE_PASS)
                if passed >= ENOUGH:
                    break
            r.judged = len(judged)
            cand_ids = judged
            survivors = [w for w in judged if gate_p[w] >= GATE_PASS]
            # Never return nothing when candidates exist: if the gates are harsher
            # than the corpus can satisfy, fall back to the best-scoring candidates
            # and say so in the receipt rather than showing an empty page.
            if len(survivors) < 10:
                ranked = sorted(cand_ids, key=lambda w: -gate_p[w])
                survivors = [w for w in ranked[:FULL_RUBRIC_MAX] if gate_p[w] > 0.05]
                r.gate_relaxed = True
        else:
            gate_p = {w: 1.0 for w in cand_ids}
            survivors = list(cand_ids)
        survivors.sort(key=lambda w: -gate_p[w])
        survivors = survivors[:FULL_RUBRIC_MAX]
        r.gated = len(survivors)
        r.stages["gate"] = round(time.time() - t, 2)
        if on_progress:
            on_progress("gated", {"passed": r.gated})

        # 4. Full rubric on the survivors only.
        t = time.time()
        full_qs = {k: v for k, v in rubric.jev_questions().items()
                   if not k.startswith("gate__")}
        detail: dict[str, dict] = {w: {} for w in survivors}
        if full_qs and survivors:
            fields = (sorted({f for s in rubric.scores + rubric.bonuses
                              for f in s.get("fields", [])})
                      or self.domain.default_fields)
            texts = [self.domain.format_item(rows[w], fields) for w in survivors]
            for w, ans in zip(survivors, jev.judge_packed(texts, full_qs, per_request=8)):
                detail[w] = ans
        r.scored = len(survivors)
        r.stages["score"] = round(time.time() - t, 2)

        # 5. Rank: rank(d) = G * (0.4 + 0.6*S) + 0.1*B
        scored = []
        for w in survivors:
            ans = detail.get(w, {})
            s_num = s_den = 0.0
            for s in rubric.scores:
                a = ans.get(f"score__{s['id']}")
                if a is None:
                    continue
                levels = max(len(s["levels"]) - 1, 1)
                s_num += float(s.get("weight", 1.0)) * (float(a.score) / levels)
                s_den += float(s.get("weight", 1.0))
            S = (s_num / s_den) if s_den else 0.0
            B = max((p_true(ans.get(f"bonus__{b['id']}")) for b in rubric.bonuses),
                    default=0.0) if rubric.bonuses else 0.0
            G = gate_p[w]
            row = dict(rows[w])
            row["item_id"] = w
            rubric_score = G * (0.4 + 0.6 * S) + 0.1 * B
            # Reciprocal rank, normalised so the top retrieved document scores 1.0.
            rr = (60.0 + 1.0) / (60.0 + ret_rank.get(w, len(cand_ids)) + 1.0)
            row["score"] = (1 - w_ret) * rubric_score + w_ret * rr
            row["rubric_score"], row["retrieval_rr"] = round(rubric_score, 4), round(rr, 4)
            row["gate_p"], row["score_s"], row["bonus_p"] = round(G, 4), round(S, 4), round(B, 4)
            row["tags"] = {t["id"]: getattr(ans.get(f"tag__{t['id']}"), "choice", None)
                           for t in rubric.tags}
            scored.append(row)
        # When a domain values its rows, ranking becomes expected value: how well
        # the item fits, multiplied by what acting on it is worth. Value is taken in
        # log space so a single enormous gift cannot outrank genuine fit, and is
        # normalised across the survivors so the scale is relative to this result set.
        if self.domain.value_of and scored:
            import math as _m
            vals = [max(self.domain.value_of(r), 1.0) for r in scored]
            lo, hi = _m.log(min(vals)), _m.log(max(vals))
            span = (hi - lo) or 1.0
            for row, v in zip(scored, vals):
                norm = (_m.log(v) - lo) / span
                row["value"] = round(v, 2)
                row["value_norm"] = round(norm, 4)
                row["fit_score"] = row["score"]
                row["score"] = row["score"] * (0.35 + 0.65 * norm)
        scored.sort(key=lambda x: -x["score"])
        top = scored[:top_k]

        # Authors live in another table; fetch them only for the results we return.
        if top and self.domain.name == "works":
            con2 = self.con()
            rows_a = con2.execute("""
                SELECT work_id, author_name, is_mit FROM authorships
                WHERE work_id IN ? ORDER BY work_id""",
                [[r["work_id"] for r in top]]).fetchall()
            con2.close()
            by_work: dict[str, list] = {}
            for wid, name, is_mit in rows_a:
                if name:
                    by_work.setdefault(wid, []).append(
                        {"name": name, "mit": bool(is_mit)})
            for row in top:
                row["authors"] = by_work.get(row["work_id"], [])[:12]

        # 6. Explanations for the top only.
        t = time.time()
        if top:
            for row in top:
                if self.domain.name == "constituents":
                    # Without the giving figures the explainer can only paraphrase
                    # the note, which reads as circular.
                    row["why_context"] = (
                        f"class of {row.get('class_year')}, {row.get('job_title')} at "
                        f"{row.get('employer')}, ${row.get('lifetime_giving',0):,.0f} "
                        f"lifetime over {row.get('gift_count')} gifts, last gift "
                        f"{row.get('last_gift_year')}, {row.get('years_since_contact')}"
                        f"y since contact. {str(row.get('notes') or '')[:260]}")
                else:
                    ctx = row.get("abstract") or row.get("notes") or ""
                    row["why_context"] = str(ctx)[:300]
            try:
                for row, why in zip(top, explain(query, top, llm_usage)):
                    row["why"] = why
            except Exception:
                pass
            for row in top:
                row.pop("why_context", None)
                # The expanded view shows the abstract; cap it so the payload stays small.
                if row.get("abstract"):
                    row["abstract"] = row["abstract"][:1400]
        r.stages["explain"] = round(time.time() - t, 2)

        r.jev = jev.usage.as_dict()
        r.llm = llm_usage.as_dict()
        jev.close()
        return {"results": top, "rubric": rubric.as_dict(), "receipt": r.as_dict()}
