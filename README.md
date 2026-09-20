# ball-knowledge
Ball knower

## GiveCampus Giving Day Triage (feat/givecampus-worklist)

Deterministic worklist ranking over the local SQLite foundation.
Rank scores are ordinal only — never probabilities, never revenue.

```sh
npm run ingest          # build data/ (once; foundation-owned)
npm run dev             # API + static web/ at http://localhost:3000
```

Live board: open `/` in the browser — the UI probes `POST /api/worklists`
and falls back to mocked rows when the API is unreachable. Key routes:
`GET /api/givecampus/health`, `GET /api/worklist?limit=20`,
`POST /api/worklist/jobs` (poll `GET /api/worklist/jobs/:id`),
`POST /api/rubric`. Copy `.env.example` to `.env.local` for server-side
`TYPESAFE_API_KEY` / `OPENAI_API_KEY` (both optional; empty = safe fallback).
