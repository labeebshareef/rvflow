/**
 * Sparse, byte-addressed, little-endian memory made of 4 KiB pages.
 * Untouched memory reads as zero.
 */
const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE_SIZE - 1;

export class Memory {
  private pages = new Map<number, Uint8Array>();

  private page(addr: number, create: boolean): Uint8Array | undefined {
    const key = (addr >>> 0) >>> PAGE_BITS;
    let p = this.pages.get(key);
    if (!p && create) {
      p = new Uint8Array(PAGE_SIZE);
      this.pages.set(key, p);
    }
    return p;
  }

  readByte(addr: number): number {
    const p = this.page(addr, false);
    return p ? p[(addr >>> 0) & PAGE_MASK] : 0;
  }

  writeByte(addr: number, value: number): void {
    this.page(addr, true)![(addr >>> 0) & PAGE_MASK] = value & 0xff;
  }

  /** Read `size` bytes little-endian, returned as an unsigned 32-bit value. */
  read(addr: number, size: 1 | 2 | 4): number {
    let v = 0;
    for (let i = size - 1; i >= 0; i--) v = (v * 256) + this.readByte((addr + i) >>> 0);
    return v >>> 0;
  }

  write(addr: number, size: 1 | 2 | 4, value: number): void {
    for (let i = 0; i < size; i++) this.writeByte((addr + i) >>> 0, (value >>> (8 * i)) & 0xff);
  }

  readBytes(addr: number, count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.readByte((addr + i) >>> 0));
    return out;
  }

  load(addr: number, bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) this.writeByte((addr + i) >>> 0, bytes[i]);
  }

  clone(): Memory {
    const m = new Memory();
    for (const [k, p] of this.pages) m.pages.set(k, p.slice());
    return m;
  }

  clear(): void {
    this.pages.clear();
  }
}
