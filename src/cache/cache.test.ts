import { describe, expect, it } from "vitest";
import { Cache, DEFAULT_DCACHE, DEFAULT_ICACHE, replay, validateConfig, type Access, type CacheConfig } from "./cache";

const cfg = (o: Partial<CacheConfig> = {}): CacheConfig => ({ ...DEFAULT_DCACHE, ...o });
const ld = (addr: number, size = 4): Access => ({ addr, size, write: false, kind: "load" });
const st = (addr: number, size = 4): Access => ({ addr, size, write: true, kind: "store" });

/** 64 B direct-mapped cache with 16 B blocks: 4 sets, blocks 0x00 and 0x40 collide in set 0. */
const DM = cfg({ sizeBytes: 64, blockBytes: 16, ways: 1 });

describe("Cache", () => {
  it("defaults are valid", () => {
    expect(validateConfig(DEFAULT_DCACHE)).toBeNull();
    expect(validateConfig(DEFAULT_ICACHE)).toBeNull();
  });

  it("breaks an address into tag | index | offset", () => {
    const c = new Cache(cfg({ sizeBytes: 256, blockBytes: 16, ways: 2 }));
    expect(c.fields(0x12345678)).toEqual({ tag: 0x2468ac, index: 7, offset: 8, tagBits: 25, indexBits: 3, offsetBits: 4 });
    const f = c.fields(0xfffffff4);
    expect(f.tag).toBe(0x1ffffff);
    expect(f.index).toBe(7);
    expect(f.offset).toBe(4);
    const fa = new Cache(cfg({ sizeBytes: 64, blockBytes: 16, ways: 4 }));
    expect(fa.fields(0x47)).toEqual({ tag: 4, index: 0, offset: 7, tagBits: 28, indexBits: 0, offsetBits: 4 });
  });

  it("thrashes a direct-mapped cache on a conflict, but not a 2-way one", () => {
    const seq = [0x00, 0x40, 0x00, 0x40, 0x00, 0x40].map((a) => ld(a));
    const dm = replay(DM, seq);
    expect(dm.results.every((r) => !r.hit)).toBe(true);
    expect(dm.results.map((r) => r.missKind)).toEqual(["compulsory", "compulsory", "conflict", "conflict", "conflict", "conflict"]);
    expect(dm.results[2].evicted).toEqual({ tag: 1, blockAddr: 0x40, dirty: false });

    const two = replay({ ...DM, ways: 2 }, seq);
    expect(two.results.map((r) => r.hit)).toEqual([false, false, true, true, true, true]);
  });

  it("LRU and FIFO choose different victims", () => {
    // 2 sets × 2 ways; 0x00, 0x20, 0x40 all map to set 0. A B A C A.
    const seq = [0x00, 0x20, 0x00, 0x40, 0x00].map((a) => ld(a));
    const base = cfg({ sizeBytes: 64, blockBytes: 16, ways: 2 });
    const lru = replay({ ...base, replacement: "LRU" }, seq);
    const fifo = replay({ ...base, replacement: "FIFO" }, seq);
    expect(lru.results.map((r) => r.hit)).toEqual([false, false, true, false, true]);
    expect(lru.results[3].evicted?.blockAddr).toBe(0x20);
    expect(fifo.results.map((r) => r.hit)).toEqual([false, false, true, false, false]);
    expect(fifo.results[3].evicted?.blockAddr).toBe(0x00);

    // Ages: 0 = most recently used / filled.
    const lruSet = lru.cache.view().sets[0].lines;
    expect(lruSet.map((l) => [l.blockAddr, l.age])).toEqual([[0x00, 0], [0x40, 1]]);
    const fifoSet = fifo.cache.view().sets[0].lines;
    expect(fifoSet.map((l) => [l.blockAddr, l.age]).sort()).toEqual([[0x00, 0], [0x40, 1]].sort());
    expect(lru.cache.view().sets[1].lines.every((l) => !l.valid && l.age === -1)).toBe(true);
  });

  it("fully associative caches only have compulsory and capacity misses", () => {
    const fa = cfg({ sizeBytes: 64, blockBytes: 16, ways: 4 });
    const blocks = [0, 1, 2, 3, 4].map((b) => ld(b * 16));
    const { results, cache } = replay(fa, [...blocks, ...blocks]);
    expect(results.every((r) => !r.hit)).toBe(true);
    const s = cache.stats();
    expect(s.compulsory).toBe(5);
    expect(s.capacity).toBe(5);
    expect(s.conflict).toBe(0);
  });

  it("classifies a known sequence with the 3C model", () => {
    const seq = [0x00, 0x40, 0x00, 0x10, 0x20, 0x30, 0x50, 0x10, 0x40].map((a) => ld(a));
    const { results, cache } = replay(DM, seq);
    expect(results.map((r) => (r.hit ? "hit" : r.missKind))).toEqual([
      "compulsory", "compulsory", "conflict", "compulsory", "compulsory", "compulsory", "compulsory", "conflict", "capacity",
    ]);
    const s = cache.stats();
    expect([s.compulsory, s.capacity, s.conflict, s.hits]).toEqual([6, 1, 2, 0]);
    expect(s.misses).toBe(s.compulsory + s.capacity + s.conflict);
  });

  it("write-back marks lines dirty and writes back dirty victims", () => {
    const { results, cache } = replay(DM, [st(0x00), ld(0x04), ld(0x40), ld(0x00)]);
    expect(results[1].hit).toBe(true);
    expect(results.some((r) => r.memWrite)).toBe(false);
    expect(results[2].writeback).toBe(true);
    expect(results[2].evicted).toEqual({ tag: 0, blockAddr: 0, dirty: true });
    expect(results[3].writeback).toBe(false);
    expect(results[3].evicted?.dirty).toBe(false);
    const s = cache.stats();
    expect(s.writebacks).toBe(1);
    expect(s.memWrites).toBe(0);
    expect([s.reads, s.writes]).toEqual([3, 1]);

    const c = new Cache(DM);
    c.access(st(0x24));
    expect(c.view().sets[2].lines[0]).toMatchObject({ valid: true, dirty: true, tag: 0, blockAddr: 0x20 });
  });

  it("write-through sends every store to memory and never dirties a line", () => {
    const wt = { ...DM, writeBack: false };
    const { results, cache } = replay(wt, [st(0x00), st(0x04), ld(0x40), st(0x08)]);
    expect(results.map((r) => r.memWrite)).toEqual([true, true, false, true]);
    expect(results[2].writeback).toBe(false);
    expect(results[2].evicted?.dirty).toBe(false);
    expect(cache.stats().memWrites).toBe(3);
    expect(cache.stats().writebacks).toBe(0);
    expect(cache.view().sets.flatMap((s) => s.lines).some((l) => l.dirty)).toBe(false);
  });

  it("does not allocate on a write miss without write-allocate", () => {
    const nwa = { ...DM, writeBack: false, writeAllocate: false };
    const { results, cache } = replay(nwa, [st(0x00), ld(0x00), st(0x04)]);
    expect(results[0]).toMatchObject({ hit: false, way: -1, memWrite: true, missKind: "compulsory" });
    expect(results[0].evicted).toBeUndefined();
    // Nothing was brought in, so the load is still the block's first reference.
    expect(results[1]).toMatchObject({ hit: false, way: 0, missKind: "compulsory" });
    expect(results[2]).toMatchObject({ hit: true, memWrite: true });
    expect(cache.stats().memWrites).toBe(2);

    // Write-back + no-write-allocate: the store goes straight to memory.
    const wbn = new Cache({ ...DM, writeAllocate: false });
    const r = wbn.access(st(0x00));
    expect(r).toMatchObject({ hit: false, way: -1, memWrite: true });
    expect(wbn.view().sets[0].lines[0].valid).toBe(false);
  });

  it("splits accesses that cross a block boundary", () => {
    const c = new Cache(DM);
    const r = c.access(ld(0x0e, 4));
    expect(r.blocks).toBe(2);
    expect(r.access).toMatchObject({ addr: 0x0e, size: 2 });
    expect(r.parts).toHaveLength(1);
    expect(r.parts![0]).toMatchObject({ blocks: 2, set: 1, hit: false });
    expect(r.parts![0].access).toMatchObject({ addr: 0x10, size: 2 });
    expect(c.stats().accesses).toBe(2);
    expect(c.access(ld(0x10, 4))).toMatchObject({ hit: true, blocks: 1 });
    expect(c.access(ld(0x10, 4)).parts).toBeUndefined();
    // Wraps around the top of the address space.
    const w = c.access(ld(0xfffffffe, 4));
    expect(w.blocks).toBe(2);
    expect(w.parts![0].access.addr).toBe(0);
  });

  it("random replacement is deterministic and restarts on reset", () => {
    const rnd = cfg({ sizeBytes: 64, blockBytes: 16, ways: 4, replacement: "random" });
    const seq = Array.from({ length: 200 }, (_, i) => ld(((i * 7919) % 13) * 16));
    const a = replay(rnd, seq).results.map((r) => [r.hit, r.way]);
    const b = replay(rnd, seq).results.map((r) => [r.hit, r.way]);
    expect(a).toEqual(b);
    const c = new Cache(rnd);
    const first = seq.map((x) => c.access(x).way);
    c.reset();
    expect(c.stats().accesses).toBe(0);
    expect(seq.map((x) => c.access(x).way)).toEqual(first);
  });

  it("computes hit rate and AMAT = hit time + miss rate × miss penalty", () => {
    const c = new Cache({ ...DM, hitCycles: 2, missPenalty: 50 });
    expect(c.stats()).toMatchObject({ accesses: 0, hitRate: 0, amat: 2 });
    for (const a of [0x00, 0x04, 0x08, 0x0c]) c.access(ld(a));
    const s = c.stats();
    expect(s).toMatchObject({ accesses: 4, hits: 3, misses: 1, hitRate: 0.75 });
    expect(s.amat).toBeCloseTo(2 + 0.25 * 50);
  });

  it("validates configurations", () => {
    expect(validateConfig(cfg({ sizeBytes: 100 }))).toMatch(/power of two/);
    expect(validateConfig(cfg({ blockBytes: 2 }))).toMatch(/at least 4/);
    expect(validateConfig(cfg({ blockBytes: 24 }))).toMatch(/power of two/);
    expect(validateConfig(cfg({ sizeBytes: 64, blockBytes: 128, ways: 1 }))).toMatch(/exceed/);
    expect(validateConfig(cfg({ ways: 3 }))).toMatch(/power of two/);
    expect(validateConfig(cfg({ sizeBytes: 64, blockBytes: 16, ways: 8 }))).toMatch(/only 4 lines/);
    expect(validateConfig(cfg({ missPenalty: -1 }))).toMatch(/penalty/);
    expect(validateConfig(cfg({ sizeBytes: 64, blockBytes: 16, ways: 4 }))).toBeNull();
    expect(() => new Cache(cfg({ ways: 3 }))).toThrow();
  });

  it("replays 200k accesses quickly", () => {
    const seq: Access[] = [];
    let x = 1;
    for (let i = 0; i < 200_000; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      seq.push(i % 3 === 0 ? st((x >>> 8) & 0xfff) : ld((i * 4) & 0x3fff));
    }
    for (const c of [DEFAULT_DCACHE, cfg({ sizeBytes: 1024, blockBytes: 16, ways: 64 }), { ...DM, replacement: "random" as const }]) {
      const t0 = performance.now();
      const { cache } = replay(c, seq);
      const ms = performance.now() - t0;
      expect(cache.stats().accesses).toBeGreaterThanOrEqual(200_000);
      expect(ms).toBeLessThan(1000);
    }
  });
});
