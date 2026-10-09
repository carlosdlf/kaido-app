/** A small least-recently-used cache. Reading or writing an entry makes it the newest. */
export class LruCache<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key) as V;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size <= this.#capacity) return;
    // Maps iterate in insertion order, so the first key is the oldest.
    for (const oldest of this.#entries.keys()) {
      this.#entries.delete(oldest);
      break;
    }
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
