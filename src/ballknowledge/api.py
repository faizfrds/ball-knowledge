#!/usr/bin/env python3
"""FastAPI backend: deep search, where-do-I-fit, trends, groups.

Every endpoint returns the cost receipt alongside its results, because the receipt
is half the pitch: it is what lets anyone check the claim that this is cheap.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .engine import Engine
from .rubric import LLMUsage, Rubric, compile_rubric
from .sanitize import MAX_PROFILE_CHARS, MAX_QUERY_CHARS, clean_profile, clean_query

DB = "data/processed/ball.duckdb"
PROCESSED = Path("data/processed")
RESULTS = Path("results")

app = FastAPI(title="Ball Knowledge")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])
engine = Engine(db=DB)


def con():
    return duckdb.connect(DB, read_only=True)


class SearchReq(BaseModel):
    query: str = Field(min_length=1, max_length=MAX_QUERY_CHARS * 4)
    top_k: int = Field(default=20, ge=1, le=100)
    pool: int = Field(default=20_000, ge=50, le=40_000)
    rubric: dict | None = None      # an edited rubric re-ranks without recompiling


class ProfileReq(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_PROFILE_CHARS * 4)
    top_k: int = Field(default=5, ge=1, le=50)


@app.get("/api/health")
def health() -> dict:
    c = con()
    n = c.execute("SELECT count(*) FROM works").fetchone()[0]
    g = c.execute("SELECT count(*) FROM read_parquet(?)",
                  [str(PROCESSED / "groups.parquet")]).fetchone()[0]
    c.close()
    return {"ok": True, "works": n, "groups": g,
            "embeddings": (PROCESSED / "embeddings.npy").exists(),
            "bm25": (PROCESSED / "fts.duckdb").exists()}


@app.post("/api/rubric")
def make_rubric(req: SearchReq) -> dict:
    """Compile only -- the UI shows the rubric as chips before paying for a search."""
    q = clean_query(req.query)
    if not q:
        raise HTTPException(400, "query is empty after cleaning")
    u = LLMUsage()
    r = compile_rubric(q, u)
    return {"rubric": r.as_dict(), "llm": u.as_dict(), "query": q}


@app.post("/api/search")
def search(req: SearchReq) -> dict:
    q = clean_query(req.query)
    if not q:
        raise HTTPException(400, "query is empty after cleaning")
    rubric = Rubric.from_dict(req.rubric, q) if req.rubric else None
    try:
        return engine.search(q, top_k=req.top_k, pool=req.pool, rubric=rubric)
    except Exception as e:
        raise HTTPException(500, f"{type(e).__name__}: {e}")


def _extract(raw: bytes, filename: str) -> str:
    """PDFs and docx come in as bytes; everything else is read as text."""
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        import io
        from pypdf import PdfReader
        return "\n".join((pg.extract_text() or "")
                          for pg in PdfReader(io.BytesIO(raw)).pages[:20])
    if name.endswith(".docx"):
        import io
        import docx
        return "\n".join(par.text for par in docx.Document(io.BytesIO(raw)).paragraphs)
    return raw.decode("utf-8", errors="ignore")


@app.post("/api/fit/upload")
async def fit_upload(files: list[UploadFile]) -> dict:
    """Drop a folder: every file becomes part of one interest profile."""
    text = "\n\n".join(_extract(await f.read(), f.filename or "") for f in files)
    return _fit(text, 5)


@app.post("/api/fit")
def fit(req: ProfileReq) -> dict:
    return _fit(req.text, req.top_k)


def _fit(text: str, top_k: int) -> dict:
    """Where do I fit: a student's own files become one interest profile, and that
    profile becomes the query. One LLM call, then the ordinary pipeline."""
    from openai import OpenAI

    # Uploaded documents are the least trusted input in the system: PDFs and docx
    # carry invisible characters routinely, and the text goes straight to a model.
    text = clean_profile(text)
    if not text:
        raise HTTPException(400, "no usable text provided")

    u = LLMUsage()
    r = OpenAI().chat.completions.create(
        model=os.environ.get("BK_LLM_MODEL", "gpt-5.2"), temperature=0,
        messages=[{"role": "user", "content":
            f"Here are a student's documents (resume, notes, project write-ups):\n\n"
            f"{text[:12000]}\n\nWrite a one-paragraph research interest profile, then "
            f"a single search query that would find MIT research groups they should "
            f'join. JSON: {{"profile": "...", "query": "..."}}'}],
        response_format={"type": "json_object"})
    u.add(r)
    prof = json.loads(r.choices[0].message.content)

    out = engine.search(prof["query"], top_k=40, pool=8_000)

    # Roll the matching papers up into the groups that wrote them.
    ids = [x["work_id"] for x in out["results"]]
    c = con()
    rows = c.execute(f"""
        SELECT g.group_id, g.lead_author, g.member_names, g.top_topics, g.n_papers,
               count(DISTINCT a.work_id) AS hits
        FROM read_parquet('{PROCESSED/"authors.parquet"}') au
        JOIN authorships a ON a.author_id = au.author_id
        JOIN read_parquet('{PROCESSED/"groups.parquet"}') g ON g.group_id = au.group_id
        WHERE a.work_id IN ? AND au.group_id IS NOT NULL
        GROUP BY 1,2,3,4,5 ORDER BY hits DESC LIMIT ?""",
        [ids, top_k]).fetchall()
    c.close()

    groups = [{"group_id": g, "lead_author": lead, "members": (mem or [])[:8],
               "top_topics": (top or [])[:5], "n_papers": n, "matching_papers": h}
              for g, lead, mem, top, n, h in rows]
    return {"profile": prof.get("profile"), "query": prof.get("query"),
            "groups": groups, "papers_to_read": out["results"][:3],
            "receipt": out["receipt"], "profile_llm": u.as_dict()}


@app.get("/api/trend/{question}")
def trend(question: str) -> dict:
    # Prefer the per-item pass: measured F1 0.966 against packed@25's 0.723.
    for name in (f"enrich_{question}_peritem.json", f"enrich_{question}.json"):
        f = RESULTS / name
        if f.exists():
            d = json.loads(f.read_text())
            d["mode"] = "per-item" if "peritem" in name else "packed@25"
            return d
    raise HTTPException(404, f"no enrichment for '{question}'")


@app.get("/api/groups")
def groups(limit: int = 50) -> dict:
    c = con()
    rows = c.execute(f"""
        SELECT group_id, size, lead_author, member_names, top_topics, top_fields,
               n_papers, total_citations, first_year, last_year
        FROM read_parquet('{PROCESSED/"groups.parquet"}')
        ORDER BY n_papers DESC LIMIT ?""", [limit]).fetchall()
    cols = [d[0] for d in c.description]
    c.close()
    return {"groups": [dict(zip(cols, r)) for r in rows]}


@app.get("/api/results/{name}")
def results_file(name: str) -> dict:
    f = RESULTS / f"{name}.json"
    if not f.exists():
        raise HTTPException(404, name)
    return json.loads(f.read_text())


@app.get("/")
def ui():
    p = Path(__file__).resolve().parent.parent.parent / "web" / "index.html"
    if not p.exists():
        raise HTTPException(404, "web/index.html not built")
    return FileResponse(p)
