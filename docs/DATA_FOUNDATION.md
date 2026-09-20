# Data foundation

Minimal TypeScript + SQLite slice for the GiveCampus Ball Knowledge prototype.
No ranking, no TypeSafe/Jev calls, no UI.

## Source of truth (read-only)

- Reference package: `20260919_GiveCampus_MIT_Hackathon-20260920T063012Z-1-001/20260919_GiveCampus_MIT_Hackathon/`
- CSVs in `data/`, schema in `schema.sql`, contract in `DATASET_README.md` (v1.2, as-of 2026-08-31).
- The app **never writes** to the reference dir. Ingest reads CSVs and writes to `./data/givecampus.sqlite` (gitignored).

## Quickstart

```powershell
npm install
npm run ingest        # build data/givecampus.sqlite (add --force to rebuild; use `npx tsx src/scripts/ingest.ts --force`)
npm run typecheck
npm run test
npm run dev           # API on http://localhost:3000
```

Overrides: `GIVE_CAMPUS_DATA_DIR`, `GIVE_CAMPUS_SCHEMA`, `GIVE_CAMPUS_DB`, `PORT`.

## Layout

- `src/config.ts` — as-of date, paths, table order, boolean columns.
- `src/normalize.ts` — empty→NULL, true/false→1/0, RFC-4180 CSV parsing.
- `src/db.ts` — open/init/count/FK-check helpers.
- `src/ingest.ts` + `src/scripts/ingest.ts` — CSV→SQLite preserving source `id`s.
- `src/features.ts` — pure as-of-safe features (paid totals exclude `recurring_parent` headers; future rows ignored; deceased/do-not-solicit = excluded).
- `src/evidence.ts` — `{table,id}` source pointers attached to every bundle.
- `src/data-access.ts` — parameterized SQLite reads + `getConstituentBundle`.
- `src/server.ts` — dependency-free Node HTTP JSON API (CORS open for local demo).
- `tests/` — vitest coverage for normalization, ingest counts/ID preservation, feature math, leakage guards.
- `web/README.md` — reserved UI slot.

## Notes for next slices

- Ranking/worklist, TypeSafe/Jev integrations, and UI are explicitly out of scope here.
- All feature math lives in code (not stored columns) so the as-of date stays a parameter.
