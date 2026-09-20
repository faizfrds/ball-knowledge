"""Background enrichment: turn a free-text rubric prompt into new Jev-derived
columns on the trial database, so ranking has more signal to separate
candidates on than the base gate/criteria pipeline alone.

See `ball_knowledge.enrichment.crawler` for the crawler itself and
`ball_knowledge.enrichment.store` for the on-disk column store.
"""

from ball_knowledge.enrichment.models import ColumnSpec, EnrichmentRubric
from ball_knowledge.enrichment.store import EnrichmentStore

__all__ = ["ColumnSpec", "EnrichmentRubric", "EnrichmentStore"]
