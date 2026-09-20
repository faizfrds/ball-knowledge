#!/usr/bin/env python3
"""Embed the corpus on Modal with bge-large-en-v1.5, fanned across CPU containers.

Two constraints shaped this. OpenAI's embedding endpoint is capped at 1M tokens/min
for this account, which makes a 35M-token corpus a 36-minute fight with a rate
limiter. And Modal GPUs need a payment method on file, which this account does not
have -- CPU containers are available, so the parallelism has to come from container
count rather than from a GPU.

That makes ONNX the right runtime: bge-large through onnxruntime on a few CPU cores
is several times faster than the torch path, and thirty containers of it beat a
single GPU's wall-clock for a job this size anyway.

Model is BAAI/bge-large-en-v1.5 (1024-dim, 335M params), baked into the image so
containers do not each re-download it. Note the asymmetry bge requires: documents are
embedded bare, queries get an instruction prefix. Getting that backwards quietly
degrades retrieval, so the prefix lives in one constant shared with the query path.

Run:  uv run python scripts/modal_embed.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import modal

MODEL_ID = "BAAI/bge-large-en-v1.5"
DIMS = 1024
CHUNK = 256
MAX_CONTAINERS = 30
CPU_PER_CONTAINER = 4.0


def _bake_model() -> None:
    """Pull and convert the weights at image build time so containers start warm."""
    from fastembed import TextEmbedding
    TextEmbedding(model_name=MODEL_ID)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("fastembed", "numpy")
    .env({"HF_HUB_DISABLE_TELEMETRY": "1"})
    .run_function(_bake_model)
)

app = modal.App("ball-knowledge-embed-cpu", image=image)


@app.cls(cpu=CPU_PER_CONTAINER, max_containers=MAX_CONTAINERS,
         timeout=3600, scaledown_window=120)
class Embedder:
    @modal.enter()
    def load(self):
        from fastembed import TextEmbedding
        self.model = TextEmbedding(model_name=MODEL_ID, threads=int(CPU_PER_CONTAINER))

    @modal.method()
    def embed(self, payload: tuple[int, list[str]]) -> tuple[int, bytes]:
        import numpy as np
        start, texts = payload
        vecs = np.asarray(list(self.model.embed(texts)), dtype=np.float32)
        vecs /= (np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-12)
        return start, vecs.astype(np.float16).tobytes()


def run():
    import duckdb
    import numpy as np

    out = Path("data/processed")
    shard_dir = out / "emb_shards"
    shard_dir.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(out / "ball.duckdb"), read_only=True)
    rows = con.execute(
        "SELECT work_id, title, abstract FROM works "
        "WHERE abstract IS NOT NULL ORDER BY work_id").fetchall()
    con.close()

    have: set[str] = set()
    for f in sorted(shard_dir.glob("*.npz")):
        try:
            have.update(np.load(f, allow_pickle=True)["ids"].tolist())
        except Exception:
            f.unlink(missing_ok=True)
    todo = [r for r in rows if r[0] not in have]
    print(f"corpus {len(rows):,} | already embedded {len(have):,} | to do {len(todo):,}",
          flush=True)
    if not todo:
        merge(out, shard_dir)
        return

    ids = [r[0] for r in todo]
    # Documents go in bare; only queries take bge's instruction prefix.
    texts = [f"{r[1] or ''}\n\n{r[2] or ''}"[:4000] for r in todo]
    chunks = [(i, texts[i:i + CHUNK]) for i in range(0, len(texts), CHUNK)]
    print(f"{len(chunks)} chunks of {CHUNK} across up to {MAX_CONTAINERS} "
          f"CPU containers", flush=True)

    t0 = time.time()
    done = 0
    embedder = Embedder()
    for res in embedder.embed.map(chunks, return_exceptions=True):
        if isinstance(res, Exception):
            print(f"  chunk failed: {type(res).__name__}: {str(res)[:120]}", flush=True)
            continue
        start, blob = res
        vecs = np.frombuffer(blob, dtype=np.float16).reshape(-1, DIMS)
        batch_ids = ids[start:start + len(vecs)]
        # Checkpoint per chunk: one lost shard is recoverable, a whole run is not.
        np.savez(shard_dir / f"shard_{start:07d}.npz",
                 ids=np.array(batch_ids, dtype=object), vecs=vecs)
        done += len(vecs)
        if done % (CHUNK * 20) < CHUNK:
            el = time.time() - t0
            print(f"  {done:,}/{len(todo):,}  {el:.0f}s  {done/max(el,1e-9):.0f}/s",
                  flush=True)

    print(f"\nembedded {done:,} in {time.time()-t0:.0f}s", flush=True)
    merge(out, shard_dir)


def merge(out: Path, shard_dir: Path) -> None:
    import numpy as np
    all_ids: list[str] = []
    mats: list[np.ndarray] = []
    for f in sorted(shard_dir.glob("*.npz")):
        z = np.load(f, allow_pickle=True)
        all_ids += z["ids"].tolist()
        mats.append(z["vecs"])
    if not mats:
        print("nothing to merge", file=sys.stderr)
        return
    emb = np.vstack(mats)
    seen, keep = set(), []
    for i, w in enumerate(all_ids):
        if w not in seen:
            seen.add(w)
            keep.append(i)
    emb, all_ids = emb[keep], [all_ids[i] for i in keep]
    np.save(out / "embeddings.npy", emb)
    (out / "embed_ids.json").write_text(json.dumps(all_ids))
    (out / "embed_meta.json").write_text(json.dumps(
        {"model": MODEL_ID, "dims": DIMS,
         "query_prefix": "Represent this sentence for searching relevant passages: "}))
    print(f"merged {emb.shape[0]:,} x {emb.shape[1]} ({emb.nbytes/1e6:.0f} MB) "
          f"-> {out/'embeddings.npy'}", flush=True)


if __name__ == "__main__":
    with modal.enable_output(), app.run():
        run()
