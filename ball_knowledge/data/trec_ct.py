"""Parsing for the TREC 2021 Clinical Trials track: patient topics, physician
qrels, and the ClinicalTrials.gov 2021-04-27 snapshot (the classic pre-2023
`<clinical_study>` XML schema, five zip parts). Files are fetched by
`scripts/download_trec_data.py`; this module only parses what's on disk.
"""

from __future__ import annotations

import gzip
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from collections.abc import Iterable, Iterator
from dataclasses import asdict, dataclass
from pathlib import Path

from ball_knowledge.models import Trial

_AGE_UNIT_TO_YEARS = {"year": 1.0, "month": 1 / 12, "week": 1 / 52.1775, "day": 1 / 365.25}
_AGE_RE = re.compile(r"([\d.]+)\s*(Year|Month|Week|Day)s?", re.IGNORECASE)


def parse_age(text: str | None) -> float | None:
    """'18 Years' -> 18.0, '6 Months' -> 0.5, 'N/A' / '' / None -> None."""
    if not text:
        return None
    match = _AGE_RE.match(text.strip())
    if not match:
        return None
    value = float(match.group(1))
    return value * _AGE_UNIT_TO_YEARS[match.group(2).lower()]


def _text(elem: ET.Element | None) -> str:
    return "".join(elem.itertext()).strip() if elem is not None else ""


def parse_trial_xml(xml_bytes: bytes) -> Trial:
    root = ET.fromstring(xml_bytes)
    eligibility = root.find(".//eligibility")

    enrollment_elem = root.find(".//enrollment")
    enrollment = None
    if enrollment_elem is not None and (enrollment_elem.text or "").strip().isdigit():
        enrollment = int(enrollment_elem.text.strip())

    arm_groups = []
    for arm in root.findall(".//arm_group"):
        label = _text(arm.find("arm_group_label"))
        kind = _text(arm.find("arm_group_type"))
        combined = f"{kind}: {label}".strip(": ").strip()
        if combined:
            arm_groups.append(combined)

    interventions = [_text(i.find("intervention_name")) for i in root.findall(".//intervention")]
    outcomes = [_text(o.find("measure")) for o in root.findall(".//primary_outcome")]
    outcomes += [_text(o.find("measure")) for o in root.findall(".//secondary_outcome")]

    return Trial(
        nct_id=_text(root.find(".//nct_id")),
        brief_title=_text(root.find(".//brief_title")),
        official_title=_text(root.find(".//official_title")),
        brief_summary=_text(root.find(".//brief_summary")),
        detailed_description=_text(root.find(".//detailed_description")),
        conditions=[c for c in (_text(e) for e in root.findall(".//condition")) if c],
        gender=(_text(eligibility.find("gender")) if eligibility is not None else "") or "All",
        minimum_age_years=parse_age(_text(eligibility.find("minimum_age"))) if eligibility is not None else None,
        maximum_age_years=parse_age(_text(eligibility.find("maximum_age"))) if eligibility is not None else None,
        overall_status=_text(root.find(".//overall_status")),
        phase=_text(root.find(".//phase")),
        study_type=_text(root.find(".//study_type")),
        eligibility_criteria_text=_text(eligibility.find("criteria")) if eligibility is not None else "",
        enrollment=enrollment,
        start_date=_text(root.find(".//start_date")) or None,
        completion_date=_text(root.find(".//completion_date")) or None,
        arm_groups=arm_groups,
        interventions=[i for i in interventions if i],
        outcomes=[o for o in outcomes if o],
    )


def iter_trial_xml_bytes(zip_paths: Iterable[Path]) -> Iterator[bytes]:
    for zip_path in zip_paths:
        with zipfile.ZipFile(zip_path) as zf:
            for info in zf.infolist():
                if info.filename.endswith(".xml"):
                    yield zf.read(info)


def iter_trials(raw_dir: Path) -> Iterator[Trial]:
    """Stream-parse every trial out of the five downloaded zip parts."""
    zip_paths = sorted(raw_dir.glob("ClinicalTrials.2021-04-27.part*.zip"))
    if not zip_paths:
        raise FileNotFoundError(
            f"No ClinicalTrials.2021-04-27.part*.zip files in {raw_dir}. "
            "Run scripts/download_trec_data.py first."
        )
    for xml_bytes in iter_trial_xml_bytes(zip_paths):
        try:
            yield parse_trial_xml(xml_bytes)
        except ET.ParseError:
            continue


def parse_topics(path: Path) -> list[tuple[str, str]]:
    """Returns [(topic_id, patient_note_text), ...]."""
    root = ET.parse(path).getroot()
    topics = []
    for t in root.findall("topic"):
        topic_id = t.get("number", "").strip()
        text = (t.text or "").strip()
        if not text:
            # TREC-CT 2023 format: <field name="...">value</field> tags under <topic>
            parts = []
            template = t.get("template")
            if template:
                parts.append(f"Condition: {template}")
            for f in t.findall("field"):
                name = f.get("name", "").strip()
                val = "".join(f.itertext()).strip()
                if val:
                    parts.append(f"{name}: {val}")
            text = ". ".join(parts)
        topics.append((topic_id, text))
    return topics


@dataclass(frozen=True)
class Qrel:
    topic_id: str
    nct_id: str
    relevance: int  # 0 = not relevant, 1 = excluded, 2 = eligible (matches TREC-CT-2021's own scale)


def parse_qrels(path: Path) -> list[Qrel]:
    qrels = []
    with path.open() as f:
        for line in f:
            parts = line.split()
            if len(parts) != 4:
                continue
            topic_id, _iteration, nct_id, relevance = parts
            if not relevance.lstrip("-").isdigit():
                continue
            qrels.append(Qrel(topic_id, nct_id, int(relevance)))
    return qrels


# ---------------------------------------------------------------------------
# A parsed-once, gzip-jsonl cache of the corpus, so repeat runs (indexing,
# eval, the app) don't re-parse ~375k XML files from the raw zips every time.
# ---------------------------------------------------------------------------


def build_corpus_cache(raw_dir: Path, out_path: Path, *, progress_every: int = 20000) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with gzip.open(out_path, "wt", encoding="utf-8") as out:
        for trial in iter_trials(raw_dir):
            out.write(json.dumps(asdict(trial)) + "\n")
            count += 1
            if progress_every and count % progress_every == 0:
                print(f"  parsed {count} trials...")
    return count


def load_corpus_cache(path: Path) -> Iterator[Trial]:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            yield Trial(**json.loads(line))
