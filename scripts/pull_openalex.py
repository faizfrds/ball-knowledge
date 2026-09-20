#!/usr/bin/env python3
"""Pull the MIT slice of OpenAlex works via the API, one gzipped JSONL shard per year.

Partitioning by publication_year lets us run independent cursor walks in parallel,
which turns a ~40 minute sequential crawl into a few minutes. Each shard is written
to a .part file and renamed on completion, so a re-run resumes at year granularity.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

API = "https://api.openalex.org/works"
MIT = "I63966007"

# referenced_works is omitted on purpose: it is ~80% of the payload and we build the
# graph from co-authorship, not citations.
SELECT = ",".join([
    "id", "doi", "title", "publication_year", "publication_date", "type",
    "cited_by_count", "authorships", "topics", "keywords", "primary_location",
    "abstract_inverted_index", "open_access", "language", "referenced_works_count",
    "fwci", "institutions_distinct_count",
])


def fetch(url: str, tries: int = 9) -> dict:
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ball-knowledge/0.1"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt == tries - 1:
                raise
            # OpenAlex throttles bursts and sends Retry-After when it does.
            wait = 2 ** attempt
            if isinstance(e, urllib.error.HTTPError):
                if e.code == 429:
                    wait = max(wait, int(e.headers.get("Retry-After", 0) or 0), 10)
                elif e.code in (400, 403, 404):
                    raise
            time.sleep(wait)
    raise RuntimeError("unreachable")


def pull_year(year: int, out_dir: Path, mailto: str, per_page: int = 200) -> tuple[int, int]:
    dest = out_dir / f"works_{year}.jsonl.gz"
    if dest.exists():
        return year, -1  # already done
    tmp = dest.with_suffix(".gz.part")
    flt = f"authorships.institutions.lineage:{MIT},publication_year:{year}"
    cursor, n = "*", 0
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        while cursor:
            q = urllib.parse.urlencode({
                "filter": flt, "select": SELECT, "per-page": per_page,
                "cursor": cursor, "mailto": mailto,
            })
            page = fetch(f"{API}?{q}")
            for w in page["results"]:
                fh.write(json.dumps(w, separators=(",", ":")) + "\n")
                n += 1
            cursor = page["meta"].get("next_cursor")
            if not page["results"]:
                break
    tmp.replace(dest)
    return year, n


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Pull MIT works from the OpenAlex API.")
    p.add_argument("--from-year", type=int, default=2015)
    p.add_argument("--to-year", type=int, default=2026)
    p.add_argument("--output-dir", default="data/raw/mit_works")
    p.add_argument("--mailto", default="nspd@terpmail.umd.edu",
                   help="polite-pool contact; OpenAlex gives it a faster pool")
    p.add_argument("--workers", type=int, default=3)
    args = p.parse_args(argv)

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    years = list(range(args.from_year, args.to_year + 1))
    t0 = time.time()
    total = 0
    print(f"Pulling MIT works {years[0]}-{years[-1]} with {args.workers} workers -> {out}",
          flush=True)
    with ThreadPoolExecutor(args.workers) as ex:
        futs = {ex.submit(pull_year, y, out, args.mailto): y for y in years}
        for f in as_completed(futs):
            year, n = f.result()
            if n < 0:
                print(f"  {year}: already present, skipped", flush=True)
            else:
                total += n
                print(f"  {year}: {n:,} works  ({time.time()-t0:.0f}s elapsed)", flush=True)
    print(f"Done: {total:,} new works in {time.time()-t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
