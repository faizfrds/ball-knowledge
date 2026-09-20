#Requires -Version 5.1
# Setup for Windows PowerShell: install deps, build SQLite DB from read-only reference CSVs, verify.
$ErrorActionPreference = "Stop"
node --version
npm --version
npm install
npm run ingest
npm run typecheck
npm run test -- --run 2>$null
if ($LASTEXITCODE -ne 0) { npm run test }
