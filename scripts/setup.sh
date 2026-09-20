#!/usr/bin/env bash
# Setup for macOS/Linux: install deps, build SQLite DB from read-only reference CSVs, verify.
set -euo pipefail
node --version
npm --version
npm install
npm run ingest
npm run typecheck
npm run test -- --run
