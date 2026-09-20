#!/usr/bin/env python3
"""Clean untrusted input, and refuse SQL the rubric compiler should not have written.

Two separate problems live here.

The first is text hygiene. A query typed or pasted by a person can carry invisible
characters, mismatched Unicode forms and control codes. Those waste tokens, split
words in ways a tokenizer handles badly, and -- in the case of bidirectional and
zero-width marks -- let text render as something other than what is sent to a model.

The second is more serious. The compiler is an LLM that writes SQL from a schema
description, and `engine.search` puts that SQL straight into a WHERE clause. A query
crafted to steer the compiler is therefore an injection path into the database. The
connection is read-only, which stops writes, but DuckDB read-only will still ATTACH
other databases and read files off disk through table functions. So compiler output
is validated against an allowlist of columns and operators before it is executed, and
anything unrecognised is dropped rather than repaired.
"""

from __future__ import annotations

import re
import unicodedata

MAX_QUERY_CHARS = 2_000
MAX_PROFILE_CHARS = 40_000
MAX_FILTER_CHARS = 400

# Every column a filter may name. Anything else is not in our schema and a filter
# that references it is a compiler hallucination at best.
ALLOWED_COLUMNS = {
    "work_id", "doi", "title", "abstract", "publication_year", "publication_date",
    "type", "language", "cited_by_count", "fwci", "referenced_works_count",
    "is_oa", "oa_url", "venue", "venue_type", "topic_id", "topic", "subfield",
    "field", "domain", "topic_ids", "topic_names", "keywords", "n_authors",
    "n_mit_authors", "institutions_distinct_count",
    # groups / authors tables
    "group_id", "size", "member_ids", "member_names", "lead_author", "n_papers",
    "total_citations", "top_topics", "top_fields", "first_year", "last_year",
    "internal_density", "author_id", "author_name", "orcid", "recent_titles",
    "degree",
}

# Functions a filter may call. Deliberately short: no file or database access.
ALLOWED_FUNCTIONS = {
    "lower", "upper", "length", "coalesce", "abs", "round", "trim",
    "array_to_string", "list_contains", "array_contains", "contains",
    "starts_with", "ends_with", "regexp_matches", "extract", "year",
}

ALLOWED_KEYWORDS = {
    "and", "or", "not", "in", "is", "null", "like", "ilike", "between",
    "true", "false", "similar", "to", "escape", "cast", "as",
    # types reachable through CAST
    "varchar", "integer", "bigint", "double", "boolean", "date",
}

# Anything on this list ends the filter immediately -- there is no legitimate reason
# for a WHERE fragment over our schema to contain these.
FORBIDDEN = re.compile(
    r"(?is)\b(select|insert|update|delete|drop|create|alter|attach|detach|copy|"
    r"pragma|install|load|export|import|call|execute|grant|revoke|vacuum|"
    r"read_csv\w*|read_parquet|read_json\w*|read_blob|read_text|glob|"
    r"sniff_csv|union|intersect|except|with|from|join|having|returning)\b"
    r"|;|--|/\*|\*/|\|\||::regclass|\$\$"
)

_IDENT = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
_STRING = re.compile(r"'(?:[^']|'')*'")


def clean_text(s: str, limit: int) -> str:
    """Normalise, strip invisible and control characters, collapse whitespace.

    NFKC first so that visually identical characters compare equal, then drop the
    Unicode Cc/Cf categories -- control codes, zero-width joiners, bidirectional
    overrides -- which are invisible on screen but reach the model. Newline and tab
    survive because pasted documents need them.
    """
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = "".join(ch for ch in s
                if ch in "\n\t" or unicodedata.category(ch) not in ("Cc", "Cf", "Cs"))
    s = re.sub(r"[ \t ]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()[:limit]


def clean_query(s: str) -> str:
    """A search query is one line; newlines in it are almost always paste artifacts."""
    return re.sub(r"\s*\n\s*", " ", clean_text(s, MAX_QUERY_CHARS)).strip()


def clean_profile(s: str) -> str:
    return clean_text(s, MAX_PROFILE_CHARS)


def safe_filter(expr: str) -> bool:
    """True if this SQL fragment is safe to drop into a WHERE clause.

    Allowlist, not blocklist: every bare identifier must be a known column, a known
    function, a known keyword, or a literal. Unknown identifiers mean the compiler
    invented something, and an invented identifier is exactly what an injection looks
    like.
    """
    if not expr or len(expr) > MAX_FILTER_CHARS:
        return False
    if FORBIDDEN.search(expr):
        return False
    if expr.count("(") != expr.count(")"):
        return False
    # Identifiers inside string literals are data, not code.
    stripped = _STRING.sub("''", expr)
    if "'" in stripped.replace("''", ""):
        return False                      # unbalanced quote
    for ident in _IDENT.findall(stripped):
        low = ident.lower()
        if low in ALLOWED_COLUMNS or low in ALLOWED_FUNCTIONS or low in ALLOWED_KEYWORDS:
            continue
        return False
    return True


def filter_filters(exprs: list[str]) -> tuple[list[str], list[str]]:
    """Split compiler filters into the ones we will run and the ones we refused."""
    keep, drop = [], []
    for e in exprs or []:
        (keep if safe_filter(str(e)) else drop).append(str(e))
    return keep, drop
