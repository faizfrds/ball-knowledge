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

## Hardening (ingestion/storage audit fixes)

- **Reference tree protection (F7/F15):** ingest resolves + canonicalizes all
  paths and refuses any output DB inside `REFERENCE_DIR`, inside the source
  data dir, or equal to the schema/data inputs. A failed ingest never deletes
  the existing destination DB.
- **Atomic build (F7):** ingest writes to `<db>.tmp.<pid>` (+sidecar cleanup),
  validates (FK check, allocation sums, row counts), runs `ANALYZE`, closes,
  then atomically renames onto the destination. Temp sidecars (`-wal/-shm/
  -journal`) are removed on success and failure.
- **Self-FK ordering (F7):** `gifts.linked_parent_gift_id` rows are sorted
  parents-first and inserted with `PRAGMA defer_foreign_keys = ON`, so
  out-of-order CSV input cannot fail immediate FK checks.
- **Strict CSV (F8):** UTF-8 BOM stripped; header must equal
  `EXPECTED_CSV_HEADERS` exactly; every row must match the header width
  (no silent drop/pad); duplicate headers rejected; unquoted whitespace
  trimmed while quoted content is preserved; parsed-vs-DB row counts compared.
- **Booleans vs text (F9):** only `BOOLEAN_COLUMNS` map `true/false` -> 1/0,
  so free text such as `notes='true'` is preserved. This intentionally
  diverges from the reference `load_sqlite.py`, which maps any such cell.
- **Finite/cents-safe money (F9/F12):** `NUMERIC_COLUMNS` enforce finite
  numbers at ingest (fail-closed, no NaN propagation). Money stays NUMERIC
  in SQLite; sum via integer cents (`toCents`/`sumCents`) and compare
  allocation sums within 1 cent — ingest fails when a gift's allocations
  do not sum to its amount. Post-death gift/interaction counts are surfaced
  as warnings (contract: zero expected).
- **DB runtime (F3/F14):** `openDb` sets `busy_timeout` (default 5000ms) and
  `foreign_keys=ON`; RW opens use WAL + `synchronous=NORMAL`. `openReadonlyDb`
  (and `openDb(..., {readonly:true})`) throws on a missing file instead of
  auto-creating an empty DB. `tableCount` allowlists `INGEST_TABLES` so table
  identifiers are never injectable. Schema sha256 is pinned in the ingest result.
- **As-of + attendance (F2):** `assertAsOf` enforces strict `YYYY-MM-DD` and
  rejects dates after `AS_OF_DATE` (backtests use T0 <= as-of).
  `getAttendanceForConstituent(db, id, asOf?)` enforces the cutoff in SQL;
  the bundle keeps the in-memory filter as defense-in-depth.
- **Pagination/projection (F3/F16):** `listConstituents` keeps its array
  return (server compat) but validates `limit` (int 1..200) and `offset`
  (int >= 0), throwing `invalid_pagination` otherwise.
  `listConstituentsPaged` adds an allowlisted projection (default
  id/preferred_name/entity_type/email_status/phone_status) plus `{rows,total,
  limit,offset}` for safe paging.

## Notes for next slices

- Ranking/worklist, TypeSafe/Jev integrations, and UI are explicitly out of scope here.
- All feature math lives in code (not stored columns) so the as-of date stays a parameter.
