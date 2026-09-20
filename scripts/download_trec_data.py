#!/usr/bin/env python3
"""Download the TREC 2021 Clinical Trials track data: patient topics, relevance
judgments (qrels), and the ClinicalTrials.gov 2021-04-27 snapshot (five zip parts,
~1.7GB total, ~375k trials).

Sources (also used by the `ir_datasets` project's `clinicaltrials/2021/trec-ct-2021`
dataset, whose checksums we reuse to verify the download):
  https://www.trec-cds.org/2021.html

Usage:
    python scripts/download_trec_data.py               # download everything
    python scripts/download_trec_data.py --docs-only    # just the trial corpus
    python scripts/download_trec_data.py --skip-docs    # just topics + qrels (fast)
"""

from __future__ import annotations

import argparse
import hashlib
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
    md5: str


TOPICS = RemoteFile(
    "topics2021.xml", "http://www.trec-cds.org/topics2021.xml", "6d842b40387d760274447c1f8d7396a8"
)
QRELS = RemoteFile(
    "qrels2021.txt", "https://trec.nist.gov/data/trials/qrels2021.txt", "0335d95c58d5f5fd9bc730bccb60ca90"
)
DOC_PARTS = [
    RemoteFile(
        f"ClinicalTrials.2021-04-27.part{i}.zip",
        f"http://www.trec-cds.org/2021_data/ClinicalTrials.2021-04-27.part{i}.zip",
        md5,
    )
    for i, md5 in enumerate(
        [
            "e12eb9a0d21452503b0ef8874c69f490",
            "f6986125506434887a162f144ca4d9a2",
            "9b7fb528b22edfcf4535154cc3d98111",
            "4fd98d209e7b62cee87af211c0c281f6",
            "a747f09ac5d4f3cd0cc75957ad9f32d8",
        ],
        start=1,
    )
]


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK_SIZE), b""):
            h.update(chunk)
    return h.hexdigest()


def download(remote: RemoteFile, dest_dir: Path) -> None:
    dest = dest_dir / remote.name
    if dest.exists() and md5_of(dest) == remote.md5:
        print(f"  already have {remote.name} (md5 verified)")
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
                # Server ignored the Range request; restart the file from scratch.
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
        if exc.code == 416:  # Range not satisfiable - already complete, fall through to verify
            pass
        else:
            raise

    digest = md5_of(tmp)
    if digest != remote.md5:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"checksum mismatch for {remote.name}: got {digest}, expected {remote.md5}")
    tmp.rename(dest)
    print(f"  verified {remote.name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs-only", action="store_true", help="only download the trial corpus zips")
    parser.add_argument("--skip-docs", action="store_true", help="skip the (large) trial corpus zips")
    parser.add_argument("--out", type=Path, default=DATA_DIR, help="output directory (default: data/raw)")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    if not args.docs_only:
        print("Topics (synthetic patient notes):")
        download(TOPICS, args.out)
        print("Qrels (physician eligible/excluded/not-relevant judgments):")
        download(QRELS, args.out)

    if not args.skip_docs:
        print("ClinicalTrials.gov 2021-04-27 snapshot (5 parts, ~1.7GB):")
        for part in DOC_PARTS:
            download(part, args.out)

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
