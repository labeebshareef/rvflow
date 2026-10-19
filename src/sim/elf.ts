/** Minimal ELF32 little-endian RISC-V loader: PT_LOAD segments and the symbol table. */

export interface ElfImage {
  entry: number;
  segments: { addr: number; bytes: Uint8Array; exec: boolean }[];
  symbols: Map<string, number>;
}

export class ElfError extends Error {}

export function parseElf(data: Uint8Array): ElfImage {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, false) !== 0x7f454c46) throw new ElfError("not an ELF file");
  if (data[4] !== 1) throw new ElfError("only 32-bit ELF files are supported");
  if (data[5] !== 1) throw new ElfError("only little-endian ELF files are supported");
  if (dv.getUint16(18, true) !== 243) throw new ElfError("not a RISC-V ELF file (e_machine != EM_RISCV)");
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const entry = u32(24);
  const phoff = u32(28);
  const shoff = u32(32);
  const phentsize = u16(42);
  const phnum = u16(44);
  const shentsize = u16(46);
  const shnum = u16(48);

  const segments: ElfImage["segments"] = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (u32(p) !== 1) continue; // PT_LOAD
    const offset = u32(p + 4);
    const vaddr = u32(p + 8);
    const filesz = u32(p + 16);
    const memsz = u32(p + 20);
    const flags = u32(p + 24);
    const bytes = new Uint8Array(memsz);
    bytes.set(data.subarray(offset, offset + filesz));
    segments.push({ addr: vaddr, bytes, exec: (flags & 1) !== 0 });
  }

  const symbols = new Map<string, number>();
  for (let i = 0; i < shnum; i++) {
    const s = shoff + i * shentsize;
    if (u32(s + 4) !== 2) continue; // SHT_SYMTAB
    const off = u32(s + 16);
    const size = u32(s + 20);
    const strtab = shoff + u32(s + 24) * shentsize;
    const strOff = u32(strtab + 16);
    const entsize = u32(s + 36) || 16;
    for (let k = 0; k < size / entsize; k++) {
      const e = off + k * entsize;
      let n = strOff + u32(e);
      let name = "";
      while (data[n]) name += String.fromCharCode(data[n++]);
      if (name) symbols.set(name, u32(e + 4));
    }
  }
  return { entry, segments, symbols };
}
