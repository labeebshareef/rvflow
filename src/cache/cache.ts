/**
 * A configurable, deterministic cache simulator for teaching.
 *
 * Pure TypeScript (no React). Lines are kept in flat typed arrays indexed by
 * `set * ways + way`, so replaying a few hundred thousand accesses is cheap.
 * Misses are classified with the "3C" model: compulsory (first reference to
 * the block), capacity (also misses in a fully-associative LRU cache of the
 * same total size) and conflict (everything else).
 */

export type Replacement = "LRU" | "FIFO" | "random";

export interface CacheConfig {
  name: string;
  /** Total data capacity in bytes, power of two. */
  sizeBytes: number;
  /** Block (line) size in bytes, power of two >= 4. */
  blockBytes: number;
  /** 1 = direct-mapped; ways * blockBytes === sizeBytes = fully associative. */
  ways: number;
  replacement: Replacement;
  /** true: write-back, false: write-through. */
  writeBack: boolean;
  writeAllocate: boolean;
  /** Cycles for a hit (used for AMAT). */
  hitCycles: number;
  /** Extra cycles for a miss (used for AMAT). */
  missPenalty: number;
}

export const DEFAULT_DCACHE: CacheConfig = {
  name: "L1 D-cache",
  sizeBytes: 256,
  blockBytes: 16,
  ways: 2,
  replacement: "LRU",
  writeBack: true,
  writeAllocate: true,
  hitCycles: 1,
  missPenalty: 20,
};

export const DEFAULT_ICACHE: CacheConfig = {
  ...DEFAULT_DCACHE,
  name: "L1 I-cache",
};

export interface Access {
  addr: number;
  size: number;
  write: boolean;
  kind: "fetch" | "load" | "store";
}

export interface AddressFields {
  tag: number;
  index: number;
  offset: number;
  tagBits: number;
  indexBits: number;
  offsetBits: number;
}

export type MissKind = "compulsory" | "capacity" | "conflict";

export interface AccessResult {
  /** The access as seen by this block (for a split access, `addr`/`size` are this block's part). */
  access: Access;
  hit: boolean;
  set: number;
  /** Way that now holds the block, or -1 when a write miss did not allocate. */
  way: number;
  fields: AddressFields;
  /** 3C classification, only on a miss. */
  missKind?: MissKind;
  /** Valid line that was replaced to make room. */
  evicted?: { tag: number; blockAddr: number; dirty: boolean };
  /** A dirty victim was written back to memory. */
  writeback: boolean;
  /** The store went to memory (write-through, or a write miss without write-allocate). */
  memWrite: boolean;
  /** Number of blocks the whole access touched (> 1 when it crosses a block boundary). */
  blocks: number;
  /** Results for the 2nd, 3rd... blocks of a split access (only on the first result). */
  parts?: AccessResult[];
}

export interface LineView {
  valid: boolean;
  dirty: boolean;
  tag: number;
  /** Byte address of the first byte of the cached block. */
  blockAddr: number;
  /**
   * Position in the replacement order within its set: 0 = most recently used
   * (LRU / random) or most recently filled (FIFO); the highest age is the next
   * victim. -1 for an invalid line.
   */
  age: number;
  /** Value of the access counter when the line was last touched (0 = never). */
  lastTouched: number;
}

export interface CacheView {
  sets: { index: number; lines: LineView[] }[];
}

export interface CacheStats {
  /** Block lookups (a split access counts once per block), = hits + misses. */
  accesses: number;
  hits: number;
  misses: number;
  reads: number;
  writes: number;
  writebacks: number;
  memWrites: number;
  compulsory: number;
  capacity: number;
  conflict: number;
  /** hits / accesses, 0..1 (0 when there were no accesses). */
  hitRate: number;
  /** Average memory access time: hitCycles + missRate * missPenalty. */
  amat: number;
}

const isPow2 = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
const log2 = (n: number) => 31 - Math.clz32(n);

const MAX_SIZE = 1 << 24;

/** Returns a human-readable message when the configuration is invalid, otherwise null. */
export function validateConfig(cfg: CacheConfig): string | null {
  const { sizeBytes, blockBytes, ways } = cfg;
  if (!isPow2(sizeBytes)) return `Cache size must be a power of two (got ${sizeBytes} B).`;
  if (sizeBytes > MAX_SIZE) return `Cache size must be at most ${MAX_SIZE / (1024 * 1024)} MiB.`;
  if (!isPow2(blockBytes) || blockBytes < 4) return `Block size must be a power of two of at least 4 B (got ${blockBytes} B).`;
  if (blockBytes > sizeBytes) return `Block size (${blockBytes} B) cannot exceed the cache size (${sizeBytes} B).`;
  const lines = sizeBytes / blockBytes;
  if (!isPow2(ways)) return `Associativity must be a power of two (got ${ways}).`;
  if (ways > lines) return `A ${sizeBytes} B cache with ${blockBytes} B blocks has only ${lines} line${lines === 1 ? "" : "s"}, so it cannot be ${ways}-way.`;
  if (!["LRU", "FIFO", "random"].includes(cfg.replacement)) return `Unknown replacement policy "${cfg.replacement}".`;
  if (!Number.isFinite(cfg.hitCycles) || cfg.hitCycles < 0) return "Hit time must be a non-negative number of cycles.";
  if (!Number.isFinite(cfg.missPenalty) || cfg.missPenalty < 0) return "Miss penalty must be a non-negative number of cycles.";
  return null;
}

const SEED = 0x2545f491;

/** Fully-associative LRU cache of block numbers, used to tell capacity from conflict misses. */
class Shadow {
  private map = new Map<number, true>();
  constructor(private capacity: number) {}
  /** Touches the block; returns true on a hit. */
  touch(block: number): boolean {
    const hit = this.map.delete(block);
    this.map.set(block, true);
    if (!hit && this.map.size > this.capacity) {
      this.map.delete(this.map.keys().next().value as number);
    }
    return hit;
  }
  has(block: number): boolean {
    return this.map.has(block);
  }
  clear() {
    this.map.clear();
  }
}

export class Cache {
  readonly cfg: CacheConfig;
  private readonly sets: number;
  private readonly ways: number;
  private readonly offsetBits: number;
  private readonly indexBits: number;
  private readonly tagBits: number;

  private valid: Uint8Array;
  private dirty: Uint8Array;
  private tags: Uint32Array;
  private used: Float64Array;
  private filled: Float64Array;

  private seen = new Set<number>();
  private shadow: Shadow;
  private clock = 0;
  private rng = SEED;
  private s = { accesses: 0, hits: 0, reads: 0, writes: 0, writebacks: 0, memWrites: 0, compulsory: 0, capacity: 0, conflict: 0 };

  constructor(cfg: CacheConfig) {
    const err = validateConfig(cfg);
    if (err) throw new Error(err);
    this.cfg = { ...cfg };
    const lines = cfg.sizeBytes / cfg.blockBytes;
    this.ways = cfg.ways;
    this.sets = lines / cfg.ways;
    this.offsetBits = log2(cfg.blockBytes);
    this.indexBits = log2(this.sets);
    this.tagBits = 32 - this.offsetBits - this.indexBits;
    this.valid = new Uint8Array(lines);
    this.dirty = new Uint8Array(lines);
    this.tags = new Uint32Array(lines);
    this.used = new Float64Array(lines);
    this.filled = new Float64Array(lines);
    this.shadow = new Shadow(lines);
  }

  fields(addr: number): AddressFields {
    const a = addr >>> 0;
    const { offsetBits, indexBits, tagBits } = this;
    return {
      tag: tagBits === 0 ? 0 : a >>> (offsetBits + indexBits),
      index: (a >>> offsetBits) & (this.sets - 1),
      offset: a & (this.cfg.blockBytes - 1),
      tagBits,
      indexBits,
      offsetBits,
    };
  }

  private blockAddr(tag: number, set: number): number {
    return ((tag << (this.offsetBits + this.indexBits)) | (set << this.offsetBits)) >>> 0;
  }

  private nextRandom(): number {
    // mulberry32
    let t = (this.rng = (this.rng + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private victim(base: number): number {
    const { ways } = this;
    for (let w = 0; w < ways; w++) if (!this.valid[base + w]) return w;
    if (this.cfg.replacement === "random") return Math.floor(this.nextRandom() * ways);
    const key = this.cfg.replacement === "LRU" ? this.used : this.filled;
    let best = 0;
    for (let w = 1; w < ways; w++) if (key[base + w] < key[base + best]) best = w;
    return best;
  }

  /** One lookup in one block. */
  private one(a: Access, blocks: number): AccessResult {
    const cfg = this.cfg;
    const addr = a.addr >>> 0;
    const fields = this.fields(addr);
    const set = fields.index;
    const tag = fields.tag;
    const base = set * this.ways;
    const blockNum = addr >>> this.offsetBits;
    const t = ++this.clock;

    this.s.accesses++;
    if (a.write) this.s.writes++;
    else this.s.reads++;

    let way = -1;
    for (let w = 0; w < this.ways; w++) {
      if (this.valid[base + w] && this.tags[base + w] === tag) {
        way = w;
        break;
      }
    }

    // A write miss that does not allocate brings nothing into the cache, so it
    // is classified but neither counts as the block's first reference nor
    // updates the shadow cache.
    const noAlloc = way < 0 && a.write && !cfg.writeAllocate;
    const firstRef = !this.seen.has(blockNum);
    const shadowHit = noAlloc ? this.shadow.has(blockNum) : this.shadow.touch(blockNum);
    if (firstRef && !noAlloc) this.seen.add(blockNum);

    if (way >= 0) {
      this.s.hits++;
      const i = base + way;
      this.used[i] = t;
      let memWrite = false;
      if (a.write) {
        if (cfg.writeBack) this.dirty[i] = 1;
        else memWrite = true;
      }
      if (memWrite) this.s.memWrites++;
      return { access: { ...a, addr }, hit: true, set, way, fields, writeback: false, memWrite, blocks };
    }

    const missKind: MissKind = firstRef ? "compulsory" : shadowHit ? "conflict" : "capacity";
    this.s[missKind]++;

    if (noAlloc) {
      this.s.memWrites++;
      return { access: { ...a, addr }, hit: false, set, way: -1, fields, missKind, writeback: false, memWrite: true, blocks };
    }

    way = this.victim(base);
    const i = base + way;
    let evicted: AccessResult["evicted"];
    let writeback = false;
    if (this.valid[i]) {
      const dirty = this.dirty[i] === 1;
      evicted = { tag: this.tags[i], blockAddr: this.blockAddr(this.tags[i], set), dirty };
      if (dirty) {
        writeback = true;
        this.s.writebacks++;
      }
    }
    this.valid[i] = 1;
    this.tags[i] = tag;
    this.used[i] = t;
    this.filled[i] = t;
    this.dirty[i] = 0;
    let memWrite = false;
    if (a.write) {
      if (cfg.writeBack) this.dirty[i] = 1;
      else memWrite = true;
    }
    if (memWrite) this.s.memWrites++;
    const r: AccessResult = { access: { ...a, addr }, hit: false, set, way, fields, missKind, writeback, memWrite, blocks };
    if (evicted) r.evicted = evicted;
    return r;
  }

  /** Performs an access; one that crosses block boundaries is split into one lookup per block. */
  access(a: Access): AccessResult {
    const addr = a.addr >>> 0;
    const size = Math.max(1, a.size | 0);
    const ob = this.offsetBits;
    const bb = this.cfg.blockBytes;
    const span = Math.ceil(((addr & (bb - 1)) + size) / bb);
    if (span === 1) return this.one({ ...a, addr, size }, 1);

    const results: AccessResult[] = [];
    let cur = addr;
    let left = size;
    for (let b = 0; b < span; b++) {
      const end = ((cur >>> ob) + 1) * bb;
      const n = Math.min(left, end - cur);
      results.push(this.one({ ...a, addr: cur, size: n }, span));
      cur = (cur + n) >>> 0;
      left -= n;
    }
    const [head, ...rest] = results;
    head.parts = rest;
    return head;
  }

  view(): CacheView {
    const { ways, cfg } = this;
    const out: CacheView["sets"] = [];
    const key = cfg.replacement === "FIFO" ? this.filled : this.used;
    for (let set = 0; set < this.sets; set++) {
      const base = set * ways;
      const order: number[] = [];
      for (let w = 0; w < ways; w++) if (this.valid[base + w]) order.push(w);
      order.sort((x, y) => key[base + y] - key[base + x]);
      const age = new Array<number>(ways).fill(-1);
      order.forEach((w, rank) => (age[w] = rank));
      const lines: LineView[] = [];
      for (let w = 0; w < ways; w++) {
        const i = base + w;
        const valid = this.valid[i] === 1;
        lines.push({
          valid,
          dirty: valid && this.dirty[i] === 1,
          tag: valid ? this.tags[i] : 0,
          blockAddr: valid ? this.blockAddr(this.tags[i], set) : 0,
          age: age[w],
          lastTouched: this.used[i],
        });
      }
      out.push({ index: set, lines });
    }
    return { sets: out };
  }

  stats(): CacheStats {
    const s = this.s;
    const misses = s.accesses - s.hits;
    const hitRate = s.accesses ? s.hits / s.accesses : 0;
    const missRate = s.accesses ? misses / s.accesses : 0;
    return {
      ...s,
      misses,
      hitRate,
      amat: this.cfg.hitCycles + missRate * this.cfg.missPenalty,
    };
  }

  reset(): void {
    this.valid.fill(0);
    this.dirty.fill(0);
    this.tags.fill(0);
    this.used.fill(0);
    this.filled.fill(0);
    this.seen.clear();
    this.shadow.clear();
    this.clock = 0;
    this.rng = SEED;
    this.s = { accesses: 0, hits: 0, reads: 0, writes: 0, writebacks: 0, memWrites: 0, compulsory: 0, capacity: 0, conflict: 0 };
  }
}

/** Replays a list of accesses on a fresh cache; returns the cache and per-access results. */
export function replay(cfg: CacheConfig, accesses: Access[]): { cache: Cache; results: AccessResult[] } {
  const cache = new Cache(cfg);
  const results = new Array<AccessResult>(accesses.length);
  for (let i = 0; i < accesses.length; i++) results[i] = cache.access(accesses[i]);
  return { cache, results };
}
