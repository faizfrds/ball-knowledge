/**
 * In-memory Jev answer cache.
 *
 * Key MUST include dataset/evidence/state/question/model/as-of
 * (see `makeCacheKey` in criterion.ts). Criterion text edits change
 * questions_hash (rescore affected); weight edits never touch the key
 * (rerank only, no new Jev calls).
 */
export interface CacheEntry<T = unknown> {
  value: T;
  storedAt: number;
  hits: number;
}

export class MemoryCache<T = unknown> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(private maxEntries = 5000) {}

  get(key: string): { hit: true; value: T } | { hit: false } {
    const e = this.map.get(key);
    if (!e) return { hit: false };
    e.hits += 1;
    return { hit: true, value: e.value };
  }

  set(key: string, value: T): void {
    if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(key, { value, storedAt: Date.now(), hits: 0 });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
