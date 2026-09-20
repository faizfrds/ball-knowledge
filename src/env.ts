import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./config.js";

/**
 * Server-side-only `.env.local` loader.
 *
 * - Reads `<repo>/.env.local` (then `<repo>/.env` as fallback) if present.
 * - Only fills `process.env` keys that are not already set (real env wins).
 * - Never logs values; never exposes them over HTTP (no route returns env).
 * - No-op in browsers (`typeof window !== "undefined"` guard).
 */
const LOADED = new Set<string>();

export function loadServerEnv(root: string = REPO_ROOT): string[] {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") return [];
  const loaded: string[] = [];
  for (const file of [".env.local", ".env"]) {
    const p = path.join(root, file);
    let text: string;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!key || LOADED.has(`${file}:${key}`)) continue;
      LOADED.add(`${file}:${key}`);
      if (process.env[key] === undefined) {
        process.env[key] = val;
        loaded.push(key);
      }
    }
  }
  return loaded;
}

/** True when a server-side Jev key is configured (never leaks the value). */
export function hasJevKey(): boolean {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") return false;
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}
