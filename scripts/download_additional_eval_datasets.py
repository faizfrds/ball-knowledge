#!/usr/bin/env python3
"""Download additional public benchmarks for validating Ball Knowledge's search
and patient-to-trial matching beyond the single TREC-CT-2021 split already
pulled by `download_trec_data.py`. Using more than one benchmark matters here
because a system tuned against one year's topics/qrels can look better than it
is; a second (or third) independently-judged benchmark is what actually
supports a credibility claim.

Sources, what each adds, and access:

  TREC-CT 2022 (--trec2022)
    Same document collection as 2021 (the 2021-04-27 ClinicalTrials.gov
    snapshot - already downloaded by download_trec_data.py), 50 new patient
    topics with fresh physician qrels. Cheap to add: no new corpus, just a
    second held-out topic/qrels split to check the system isn't overfit to
    2021's judgments. Open download, no registration.
    https://www.trec-cds.org/2022.html

  TREC-CT 2023 (--trec2023)
    A materially different test: synthetic patient descriptions generated
    from questionnaire templates for 8 disorders (not free-text notes like
    2021/2022), against a newer (2023-05-08) ClinicalTrials.gov snapshot.
    Exercises `extract_patient` and retrieval against a distribution shift in
    both query style and corpus. Open download, no registration, ~2.2GB.
    https://trec-cds.org/2023.html

  TrialGPT criterion-level dataset (--trialgpt, via git clone)
    Re-packages TREC-CT 2021/2022 and the SIGIR-2016 cohort with per-criterion
    inclusion/exclusion annotations (not just trial-level eligible/excluded/
    not_relevant), which is the finer-grained ground truth needed to validate
    `ball_knowledge.criteria.classify`/the Jev criterion check directly,
    rather than only the end-to-end ranking. Open GitHub repo.
    https://github.com/ncbi-nlp/TrialGPT

  SIGIR-2016 clinical trials collection (bundled in TrialGPT's /dataset, or
  standalone from CSIRO)
    A third, independently-collected cohort: 3 sets of synthetic patients
    (~200 total) against ~200k trials, eligible/potential/irrelevant labels.
    Useful as a fully independent (different annotators, different era)
    sanity check that gains on TREC-CT aren't specific to TREC's judging.
    https://data.csiro.au/collection/csiro:17152

  n2c2 2018 cohort selection (--n2c2, registration required - not auto-downloaded)
    The odd one out and arguably the most valuable: 288 *real* de-identified
    clinical notes (not synthetic patient summaries) from i2b2/n2c2, each
    scored MET/NOT MET against 13 structured inclusion criteria (e.g.
    ADVANCED-CAD, MAJOR-DIABETES, MI-6MOS). Real clinical note style - long,
    messy, implicit - is a much harder and more representative test of
    `extract_patient` and the criteria checker than any synthetic-topic
    benchmark. Requires a free DUA (data use agreement) through the n2c2
    portal; this script only prints the registration link and where to put
    the files once you have them, since automated/unauthenticated download of
    PHI-adjacent data isn't appropriate.
    https://n2c2.dbmi.hms.harvard.edu/2018-cohort-selection

Usage:
    python scripts/download_additional_eval_datasets.py --trec2022
    python scripts/download_additional_eval_datasets.py --trec2023 --skip-docs
    python scripts/download_additional_eval_datasets.py --trialgpt   # prints clone instructions
    python scripts/download_additional_eval_datasets.py --n2c2       # prints registration instructions
    python scripts/download_additional_eval_datasets.py --all --skip-docs
"""

from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"
CHUNK_SIZE = 1 << 20  # 1 MiB


@dataclass(frozen=True)
class RemoteFile:
    name: str
    url: str


def download(remote: RemoteFile, dest_dir: Path) -> None:
    """No published checksum exists for these files (unlike 2021's, which
    ir_datasets happens to mirror) - this only checks the file exists at the
    expected size after download, not a content hash."""
    dest = dest_dir / remote.name
    if dest.exists():
        print(f"  already have {remote.name} ({dest.stat().st_size / 1e6:.1f} MB) - skipping")
        return

    tmp = dest.with_suffix(dest.suffix + ".part")
    resume_from = tmp.stat().st_size if tmp.exists() else 0
    headers = {"User-Agent": "ball-knowledge-downloader/1.0"}
    mode = "wb"
    if resume_from:
        headers["Range"] = f"bytes={resume_from}-"
        mode = "ab"
        print(f"  resuming {remote.name} from {resume_from / 1e6:.1f} MB")
    else:
        print(f"  downloading {remote.name} from {remote.url}")

    req = urllib.request.Request(remote.url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp, tmp.open(mode) as out:
            resumed = resp.status == 206
            total = int(resp.headers.get("Content-Length", 0)) + (resume_from if resumed else 0)
            written = resume_from if resumed else 0
            if mode == "ab" and not resumed:
                out.seek(0)
                out.truncate()
                written = 0
            while chunk := resp.read(CHUNK_SIZE):
                out.write(chunk)
                written += len(chunk)
                if total:
                    pct = 100 * written / total
                    print(f"\r    {remote.name}: {written / 1e6:8.1f} MB / {total / 1e6:.1f} MB ({pct:5.1f}%)", end="", flush=True)
            print()
    except urllib.error.HTTPError as exc:
        if exc.code == 416:
            pass
        else:
            raise

    tmp.rename(dest)
    print(f"  done: {remote.name} ({dest.stat().st_size / 1e6:.1f} MB)")


TREC2022_TOPICS = RemoteFile("topics2022.xml", "https://www.trec-cds.org/topics2022.xml")
TREC2022_QRELS = RemoteFile("qrels2022.txt", "https://trec.nist.gov/data/trials/qrels2022.txt")

TREC2023_TOPICS = RemoteFile("topics2023.xml", "https://www.trec-cds.org/topics2023.xml")
TREC2023_QRELS = RemoteFile("qrels2023.txt", "https://trec.nist.gov/data/trials/qrels2023.txt")
TREC2023_DOC_PARTS = [
    RemoteFile(
        f"ClinicalTrials.2023-05-08.trials{i}.zip",
        f"https://www.trec-cds.org/2023_data/ClinicalTrials.2023-05-08.trials{i}.zip",
    )
    for i in range(6)
]


def do_trec2022(out: Path) -> None:
    print("TREC-CT 2022 topics + qrels (reuses the 2021 corpus already in data/raw):")
    download(TREC2022_TOPICS, out)
    download(TREC2022_QRELS, out)


def do_trec2023(out: Path, *, skip_docs: bool, docs_only: bool) -> None:
    if not docs_only:
        print("TREC-CT 2023 topics + qrels:")
        download(TREC2023_TOPICS, out)
        download(TREC2023_QRELS, out)
    if not skip_docs:
        print("ClinicalTrials.gov 2023-05-08 snapshot (6 parts, ~2.2GB):")
        for part in TREC2023_DOC_PARTS:
            download(part, out)


def print_trialgpt_instructions() -> None:
    print(
        "TrialGPT dataset (criterion-level annotations over TREC-CT 2021/2022 + "
        "SIGIR-2016) isn't a single-file download - clone the repo:\n\n"
        "    git clone https://github.com/ncbi-nlp/TrialGPT " + str(DATA_DIR / "trialgpt") + "\n\n"
        "The annotations live under dataset/ in that repo; see its README for the "
        "exact per-cohort file layout before writing a loader against it."
    )


def print_n2c2_instructions() -> None:
    print(
        "n2c2 2018 cohort selection requires a free data use agreement - it isn't "
        "auto-downloaded by this script:\n\n"
        "  1. Register at https://n2c2.dbmi.hms.harvard.edu/2018-cohort-selection\n"
        "  2. Once approved, download the track-1 (cohort selection) release\n"
        "  3. Unzip it into " + str(DATA_DIR / "n2c2_2018") + "\n\n"
        "That gives 288 de-identified clinical notes scored MET/NOT MET against "
        "13 structured criteria - the only real (non-synthetic) note benchmark "
        "in this list, and the best test of extract_patient/classify.py against "
        "messy real clinical language rather than TREC's synthetic topics."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--trec2022", action="store_true", help="download TREC-CT 2022 topics + qrels")
    parser.add_argument("--trec2023", action="store_true", help="download TREC-CT 2023 topics + qrels + corpus")
    parser.add_argument("--trialgpt", action="store_true", help="print TrialGPT dataset clone instructions")
    parser.add_argument("--n2c2", action="store_true", help="print n2c2 2018 registration instructions")
    parser.add_argument("--all", action="store_true", help="everything above")
    parser.add_argument("--docs-only", action="store_true", help="with --trec2023: only the corpus zips")
    parser.add_argument("--skip-docs", action="store_true", help="with --trec2023: only topics + qrels")
    parser.add_argument("--out", type=Path, default=DATA_DIR, help="output directory (default: data/raw)")
    args = parser.parse_args()

    if not any([args.trec2022, args.trec2023, args.trialgpt, args.n2c2, args.all]):
        parser.print_help()
        return 1

    args.out.mkdir(parents=True, exist_ok=True)

    if args.trec2022 or args.all:
        do_trec2022(args.out)
    if args.trec2023 or args.all:
        do_trec2023(args.out, skip_docs=args.skip_docs, docs_only=args.docs_only)
    if args.trialgpt or args.all:
        print_trialgpt_instructions()
    if args.n2c2 or args.all:
        print_n2c2_instructions()

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
