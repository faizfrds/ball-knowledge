#!/usr/bin/env bash
# Waits for the embedding job to write its matrix, then builds BM25, smoke-tests the
# engine end to end, and runs the baseline comparison. Meant to run unattended.
set -u
cd "$(dirname "$0")/.."
set -a; . /Users/priyadarshannarayanasamy/jjjv/.env; set +a

echo "waiting for data/processed/embeddings.npy ..."
while [ ! -f data/processed/embeddings.npy ]; do
  pgrep -f "embed.py" >/dev/null || { echo "modal job is gone and no matrix was written; aborting"; exit 1; }
  sleep 20
done
echo "embeddings landed: $(ls -la data/processed/embeddings.npy | awk '{print $5}') bytes"

echo "=== building BM25 ==="
uv run python -c "import sys; sys.path.insert(0,'src'); from ballknowledge.index import build_bm25; build_bm25()" || exit 1

echo "=== restarting API so it picks up the index ==="
pkill -f "uvicorn" 2>/dev/null; sleep 2
PYTHONPATH=src nohup uv run python -m uvicorn ballknowledge.api:app --host 127.0.0.1 --port 8000 \
  > /private/tmp/claude-501/-Users-priyadarshannarayanasamy-jjjv/e847133c-2b84-4a00-a796-e3be6189e164/scratchpad/api.log 2>&1 &
sleep 8
curl -s http://127.0.0.1:8000/api/health; echo

echo "=== engine smoke test ==="
uv run python - <<'PY'
import sys, json; sys.path.insert(0, "src")
from ballknowledge.engine import Engine
out = Engine().search("machine learning applied to neural recordings", top_k=5, pool=4000)
print(json.dumps(out["receipt"], indent=2))
for r in out["results"]:
    print(" -", (r.get("title") or "")[:90], "|", r.get("why", "")[:70])
PY

echo "=== baseline comparison (8 queries) ==="
uv run python scripts/compare_baselines.py --n-queries 8 --pool 8000 2>&1 | tail -25
echo "=== ALL DONE ==="
