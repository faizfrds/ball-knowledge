# web/ — reserved for the interactive demo UI (not implemented in the data-foundation slice)

The data foundation exposes a local JSON API (`src/server.ts`):

- `GET /api/health`
- `GET /api/constituents?limit&offset`
- `GET /api/constituents/:id` (constituent + as-of-safe features + source evidence)

A future Vite + React (or Next.js) app can live here and call those endpoints.
Keep the API CORS-open for `http://localhost:*` during local demos.
Do not add UI dependencies until the ranking/UX slice is scoped.
