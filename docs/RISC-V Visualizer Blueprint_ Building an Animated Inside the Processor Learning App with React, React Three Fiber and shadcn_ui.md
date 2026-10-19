# RISC-V Visualizer Blueprint: Building an Animated "Inside the Processor" Learning App with React, React Three Fiber and shadcn/ui

Start with an RV32I simulator written in TypeScript and a classic single-cycle datapath shown in 2.5D. Each instruction should play as a narrated sequence that the learner steps through: encode → fetch → decode → read registers → ALU → memory → write back → update PC. Every animation should be generated from a per-instruction "micro-event trace" produced by your simulator, so adding an instruction means adding a row of data, not writing new animation code. Ripes is the de-facto teaching simulator, but no existing tool combines a modern UI, an animated encoding view, guided narration and replay of a single instruction. That is the gap your app can fill, and a solo React developer can realistically ship a polished MVP in about two months.

## TL;DR

- **What to build first:** an RV32I (40 instructions) simulator core you write yourself in TypeScript. Pair it with a single-cycle datapath shown in 2.5D and a bit-field encoding visualizer. Every step is learner-controlled (step, scrub, replay, "explain this step"). Then add M, pseudo-instructions and programs; the 5-stage pipeline with hazards; traps/CSRs/privilege; C/F/D/A/B/V; and finally caches and out-of-order execution.
- **ISA scope:** the current ratified manuals are the 20260120 release of the Unprivileged and Privileged ISA manuals. Extensions have kept arriving since then (Zalasr in October 2025, Ziccid in June 2026, Sspmp in August 2026). Use the machine-readable riscv-opcodes repo as the encoding source of truth instead of hand-typing tables, and test against riscv-tests plus a differential "oracle" simulator.
- **Pedagogy:** research supports animations, but only modestly and only when they are learner-controlled and show what matters. Meta-analytic advantage of animation over static pictures is d = 0.37.\[1\] Hundhausen, Douglas & Stasko's meta-study found that only 11 of 24 algorithm-visualization experiments yielded a significant result, and concluded that "how students use AV technology has a greater impact on effectiveness than what AV technology shows them." So make every step interruptible, and ask the learner to predict before you reveal ("which register will change?").

---

## 1. Key Recommendations

1. **Choose 2.5D over free-flying 3D.** Use an orthographic or low-angle camera looking down on a flat circuit board. Components are extruded blocks, wires are tubes, and "data packets" are glowing particles. Use depth only for layering (control signals float above datapath wires; pipeline registers stand as walls between stages). Tversky and colleagues warn that animations are often too complex or too fast to perceive accurately; a fixed, readable camera with guided moves reduces that load.\[2\]
2. **Write the simulator core yourself, starting with RV32I.** The base ISA is small and regular, ideal for your own deep learning. Use an existing simulator (e.g., the `@specy/risc-v` npm package, a TypeScript build of RARS) only as a test oracle.\[3\]\[4\] You need hooks into every internal value (immediates, mux selections, ALU inputs), which off-the-shelf emulators don't expose.
3. **Make the trace the architecture.** `step()` returns `{ before, after, events[] }`, where each event names a datapath component and its values. The animation timeline is compiled from these events and a per-class choreography template. Scrubbing moves a time cursor; undo restores per-instruction snapshots (Ripes's reversible simulation proved the value of this).\[5\]
4. **Teach encoding as the first animation.** No popular tool animates `addi t1, t1, 10` turning into the colored 32-bit word `0x00A30313`. This is your signature feature, and it pays off when the B/J-format scrambling is revealed.
5. **Build the progression into the product:** bits → registers → encoding → one instruction → programs → pipeline → hazards → traps → virtual memory → caches/OoO. Each level is a chapter with a guided tour plus a free sandbox.
6. **Stack:** Vite + React 19 + TypeScript, `@react-three/fiber` v9 (which pairs with React 19) + drei + `@react-three/postprocessing` (selective bloom), zustand, GSAP 3.13+ for timelines (GSAP's 3.13 release made it "100% FREE including ALL of the bonus plugins… even for commercial use", announced April 30, 2025), CodeMirror 6, shadcn/ui + Tailwind, Vitest, static hosting.

---

## 2. Complete RISC-V ISA Reference

### 2.1 Authoritative sources and versions

- **Ratified manuals:** *Volume I: Unprivileged Architecture* and *Volume II: Privileged Architecture*, **Version 20260120**, in the RISC-V Ratified Specifications Library (docs.riscv.org). Previous releases were 20250508 and 20240411. Volume II 20260120 contains Machine ISA 1.13, Supervisor ISA 1.13 and Hypervisor ISA 1.0.\[6\]\[7\]\[8\]
- **Editorial changes** in the 20260120 Unprivileged manual: all ratified extensions through February 2025 are included; the draft Zam extension was removed; and **the sketch of the RV128I base ISA was removed as unratified content**.\[9\]
- **Newer ratifications not yet merged into a manual** (per the RISC-V Tech Hub "Ratified ISA Extensions" page): Sspmp (August 2026), Ziccid (June 2026), Zalasr (October 2025), Svrsw60t59b (August 2025), Zilsd/Zclsd (February 2025), Debug Sdext/Sdtrig (February 2025).\[10\]
- **Machine-readable encodings:** `github.com/riscv/riscv-opcodes` enumerates every standard opcode and CSR and generates `instr_dict.json` (mask/match per instruction, extension tags); its artifacts feed Spike and the ISA manual.\[11\] An open issue notes `instr_dict` lacks the format type (R/I/S…), so add that field yourself.\[12\]
- **Human-friendly references:** the Patterson & Hennessy "green card", the RISC-V Reference Card, five-embeddev's HTML ISA/CSR pages, msyksphinz's instruction tables, the RISC-V Assembly Programmer's Manual (riscv-non-isa/riscv-asm-manual), and the psABI (riscv-non-isa/riscv-elf-psabi-doc).

### 2.2 Base ISAs

| Base | XLEN | Integer regs | Status / notes |
|---|---|---|---|
| RV32I | 32 | 32 (x0–x31) | Ratified, v2.1. Your MVP target. |
| RV64I | 64 | 32 | Ratified, v2.1. Linux-class base; RVA profiles require it. |
| RV32E / RV64E | 32/64 | 16 (x0–x15) | Ratified January 2023 (v2.0). Same encodings. ilp32e ABI. |
| RV128I | 128 | 32 | Never ratified; sketch removed from the 20260120 manual. |

### 2.3 The six instruction formats (32-bit)

```
 31        25 24    20 19    15 14  12 11        7 6      0
| funct7     | rs2    | rs1    |funct3| rd         | opcode |  R-type
| imm[11:0]           | rs1    |funct3| rd         | opcode |  I-type
| imm[11:5]  | rs2    | rs1    |funct3| imm[4:0]   | opcode |  S-type
|i12|imm10:5 | rs2    | rs1    |funct3|imm4:1 |i11 | opcode |  B-type
| imm[31:12]                          | rd         | opcode |  U-type
|i20| imm[10:1]   |i11| imm[19:12]    | rd         | opcode |  J-type
```

Bits [1:0] of every 32-bit instruction are `11`; any other value means a 16-bit compressed (C) instruction.

**Why the immediates are "scrambled":**
1. **The sign bit is always instruction bit 31**, so sign extension can start before decoding finishes.
2. **rs1, rs2 and rd never move**, so register reads can start in parallel with decoding.
3. **Each immediate bit comes from as few instruction positions as possible.** B-type is S-type with bits rotated: branch offsets are always even, so imm[0] is implied and imm[11] moves into bit 7 (where S-type keeps imm[0]). J-type relates to U/I-type the same way. Each immediate-generator output bit then needs only a small mux. Show this as an "Immediate Generator" lens where bits fly into their slots.

**Immediate values (sign-extended from inst[31]):**
- I: `inst[31:20]` → −2048…2047
- S: `inst[31:25] ‖ inst[11:7]`
- B: `inst[31] ‖ inst[7] ‖ inst[30:25] ‖ inst[11:8] ‖ 0` → ±4 KiB
- U: `inst[31:12] ‖ 12'b0`
- J: `inst[31] ‖ inst[19:12] ‖ inst[20] ‖ inst[30:21] ‖ 0` → ±1 MiB

### 2.4 RV32I: full instruction list (40 instructions)

Opcodes: LUI `0110111`, AUIPC `0010111`, JAL `1101111`, JALR `1100111`, BRANCH `1100011`, LOAD `0000011`, STORE `0100011`, OP-IMM `0010011`, OP `0110011`, MISC-MEM `0001111`, SYSTEM `1110011`.

| # | Mnemonic | Fmt | opcode | funct3 | funct7 / imm | Semantics |
|---|---|---|---|---|---|---|
| 1 | LUI rd, imm | U | 0110111 | – | – | rd ← imm<<12 |
| 2 | AUIPC rd, imm | U | 0010111 | – | – | rd ← PC + (imm<<12) |
| 3 | JAL rd, off | J | 1101111 | – | – | rd ← PC+4; PC ← PC+off |
| 4 | JALR rd, off(rs1) | I | 1100111 | 000 | – | t ← PC+4; PC ← (rs1+imm) & ~1; rd ← t |
| 5 | BEQ rs1, rs2, off | B | 1100011 | 000 | – | if rs1 == rs2, PC ← PC+off |
| 6 | BNE | B | 1100011 | 001 | – | if rs1 ≠ rs2 |
| 7 | BLT | B | 1100011 | 100 | – | if rs1 < rs2 (signed) |
| 8 | BGE | B | 1100011 | 101 | – | if rs1 ≥ rs2 (signed) |
| 9 | BLTU | B | 1100011 | 110 | – | if rs1 < rs2 (unsigned) |
| 10 | BGEU | B | 1100011 | 111 | – | if rs1 ≥ rs2 (unsigned) |
| 11 | LB rd, off(rs1) | I | 0000011 | 000 | – | rd ← sext(M8[rs1+imm]) |
| 12 | LH | I | 0000011 | 001 | – | rd ← sext(M16[…]) |
| 13 | LW | I | 0000011 | 010 | – | rd ← M32[…] |
| 14 | LBU | I | 0000011 | 100 | – | rd ← zext(M8[…]) |
| 15 | LHU | I | 0000011 | 101 | – | rd ← zext(M16[…]) |
| 16 | SB rs2, off(rs1) | S | 0100011 | 000 | – | M8[rs1+imm] ← rs2[7:0] |
| 17 | SH | S | 0100011 | 001 | – | M16 ← rs2[15:0] |
| 18 | SW | S | 0100011 | 010 | – | M32 ← rs2 |
| 19 | ADDI | I | 0010011 | 000 | – | rd ← rs1 + imm |
| 20 | SLTI | I | 0010011 | 010 | – | rd ← (rs1 <s imm) ? 1 : 0 |
| 21 | SLTIU | I | 0010011 | 011 | – | rd ← (rs1 <u sext(imm)) ? 1 : 0 |
| 22 | XORI | I | 0010011 | 100 | – | rd ← rs1 ^ imm |
| 23 | ORI | I | 0010011 | 110 | – | rd ← rs1 \| imm |
| 24 | ANDI | I | 0010011 | 111 | – | rd ← rs1 & imm |
| 25 | SLLI | I* | 0010011 | 001 | 0000000 | rd ← rs1 << shamt[4:0] |
| 26 | SRLI | I* | 0010011 | 101 | 0000000 | logical shift right |
| 27 | SRAI | I* | 0010011 | 101 | 0100000 | arithmetic shift right |
| 28 | ADD | R | 0110011 | 000 | 0000000 | rd ← rs1 + rs2 |
| 29 | SUB | R | 0110011 | 000 | 0100000 | rd ← rs1 − rs2 |
| 30 | SLL | R | 0110011 | 001 | 0000000 | rd ← rs1 << rs2[4:0] |
| 31 | SLT | R | 0110011 | 010 | 0000000 | signed compare |
| 32 | SLTU | R | 0110011 | 011 | 0000000 | unsigned compare |
| 33 | XOR | R | 0110011 | 100 | 0000000 | rd ← rs1 ^ rs2 |
| 34 | SRL | R | 0110011 | 101 | 0000000 | logical shift right |
| 35 | SRA | R | 0110011 | 101 | 0100000 | arithmetic shift right |
| 36 | OR | R | 0110011 | 110 | 0000000 | rd ← rs1 \| rs2 |
| 37 | AND | R | 0110011 | 111 | 0000000 | rd ← rs1 & rs2 |
| 38 | FENCE pred, succ | I | 0001111 | 000 | fm/pred/succ | memory ordering (FENCE.TSO, PAUSE are special encodings) |
| 39 | ECALL | I | 1110011 | 000 | imm=0 | environment call → `0x00000073` |
| 40 | EBREAK | I | 1110011 | 000 | imm=1 | breakpoint → `0x00100073` |

*I\* = shift-immediate form: imm[11:5] acts as funct7 and imm[4:0] is shamt.*

**RV64I additions:** LWU (LOAD, 110), LD (LOAD, 011), SD (STORE, 011); ADDIW (opcode `0011011`, 000), SLLIW (001), SRLIW/SRAIW (101); ADDW/SUBW (opcode `0111011`, 000, funct7 0000000/0100000), SLLW (001), SRLW/SRAW (101). In RV64, SLLI/SRLI/SRAI take a 6-bit shamt, and all *W ops compute on 32 bits and sign-extend to 64.

### 2.5 Standard extensions

**Naming:** `RV32IMAC`, `RV64GC`, etc. **G = IMAFD + Zicsr + Zifencei.**\[13\] Z-extensions start with Z plus the closest single-letter category (Zi*, Zb*, Zf*, Zv*, Zk*, Zc*). S*/Sm*/Ss*/Sh* names are privileged extensions.

#### M: multiply/divide (OP `0110011`, funct7 `0000001`)
| funct3 | 000 | 001 | 010 | 011 | 100 | 101 | 110 | 111 |
|---|---|---|---|---|---|---|---|---|
| Instr | MUL | MULH | MULHSU | MULHU | DIV | DIVU | REM | REMU |

RV64 adds MULW, DIVW, DIVUW, REMW, REMUW (opcode `0111011`). **Division never traps:** x/0 gives quotient −1 and remainder x; −2³¹/−1 gives quotient −2³¹, remainder 0. *Zmmul* is the multiply-only subset.

#### A: atomics (AMO `0101111`, funct3 010 = .W, 011 = .D; bits 26/25 = aq/rl)
| funct5 | Instr | funct5 | Instr |
|---|---|---|---|
| 00010 | LR.W/D | 00011 | SC.W/D |
| 00001 | AMOSWAP | 00000 | AMOADD |
| 00100 | AMOXOR | 01100 | AMOAND |
| 01000 | AMOOR | 10000 | AMOMIN |
| 10100 | AMOMAX | 11000 | AMOMINU |
| 11100 | AMOMAXU | | |

A was split (April 2024) into **Zalrsc** (LR/SC) and **Zaamo** (AMOs). Related: **Zacas** (AMOCAS.W/D/Q), **Zabha** (byte/halfword AMOs), **Zawrs** (WRS.NTO, WRS.STO), **Zalasr** (load-acquire/store-release).\[10\]

#### F / D / Q / Zfh: floating point
- **Registers f0–f31** plus **fcsr** (frm rounding mode + fflags NV/DZ/OF/UF/NX).
- **Opcodes:** LOAD-FP `0000111` / STORE-FP `0100111` (funct3 010 = S, 011 = D, 100 = Q, 001 = H); FMADD `1000011`, FMSUB `1000111`, FNMSUB `1001011`, FNMADD `1001111`; OP-FP `1010011` with funct7[26:25] format (00 S, 01 D, 10 H, 11 Q).
- **F instructions:** FLW, FSW, FMADD/FMSUB/FNMSUB/FNMADD.S, FADD/FSUB/FMUL/FDIV/FSQRT.S, FSGNJ/FSGNJN/FSGNJX.S, FMIN/FMAX.S, FCVT.W[U].S, FCVT.S.W[U], FMV.X.W, FMV.W.X, FEQ/FLT/FLE.S, FCLASS.S (RV64 adds FCVT.L[U].S, FCVT.S.L[U]).
- **D:** the same with .D (FLD/FSD) plus FCVT.S.D/FCVT.D.S (RV64: FMV.X.D/FMV.D.X). **Q:** .Q equivalents. **Zfh/Zfhmin:** half precision. **Zfa:** FLI, FMINM/FMAXM, FROUND/FROUNDNX, FCVTMOD.W.D, FLEQ/FLTQ, FMVH.X.D/FMVP.D.X. **Zfinx/Zdinx/Zhinx:** FP in integer registers. **Zfbfmin:** BF16 conversions.
- **NaN-boxing:** narrower values in wider f-registers must have all upper bits set to 1.

#### C: compressed (16-bit), now Zca (+Zcf, Zcd)
Formats CR, CI, CSS, CIW, CL, CS, CA, CB, CJ.\[14\] The 3-bit register fields address only x8–x15 (s0, s1, a0–a5). Every C instruction expands 1:1 to a 32-bit instruction, a great "expand" animation.
- **Quadrant 0:** C.ADDI4SPN, C.FLD, C.LW, C.FLW/C.LD, C.FSD, C.SW, C.FSW/C.SD
- **Quadrant 1:** C.NOP, C.ADDI, C.JAL (RV32)/C.ADDIW (RV64), C.LI, C.ADDI16SP, C.LUI, C.SRLI, C.SRAI, C.ANDI, C.SUB, C.XOR, C.OR, C.AND, C.SUBW, C.ADDW, C.J, C.BEQZ, C.BNEZ
- **Quadrant 2:** C.SLLI, C.FLDSP, C.LWSP, C.FLWSP/C.LDSP, C.JR, C.MV, C.EBREAK, C.JALR, C.ADD, C.FSDSP, C.SWSP, C.FSWSP/C.SDSP
- **Code-size reduction (April 2023):** **Zcb** (C.LBU, C.LHU, C.LH, C.SB, C.SH, C.ZEXT.B/H/W, C.SEXT.B/H, C.NOT, C.MUL), **Zcmp** (CM.PUSH, CM.POP, CM.POPRET, CM.POPRETZ, CM.MVA01S, CM.MVSA01), **Zcmt** (CM.JT, CM.JALT), Zce.\[10\] Zcmp/Zcmt reuse Zcd encodings, so they are incompatible with Zcd.

#### Zicsr, Zifencei, counters, hints
- **Zicsr** (SYSTEM): CSRRW 001, CSRRS 010, CSRRC 011, CSRRWI 101, CSRRSI 110, CSRRCI 111; CSR address in bits [31:20].
- **Zifencei:** FENCE.I (MISC-MEM, funct3 001).
- **Zicntr:** cycle 0xC00, time 0xC01, instret 0xC02 (+ …h halves on RV32). **Zihpm:** hpmcounter3–31.
- **Misc:** Zihintpause (PAUSE), Zihintntl (NTL.*), Zimop (MOP.R.n, MOP.RR.n), Zcmop (C.MOP.n), CMO (CBO.CLEAN/FLUSH/INVAL/ZERO, PREFETCH.I/R/W), **Zicond** (CZERO.EQZ funct3 101, CZERO.NEZ funct3 111, funct7 0000111), Zicfilp (LPAD) and Zicfiss (SSPUSH, SSPOPCHK, SSRDP, SSAMOSWAP) for control-flow integrity.\[15\]

#### B: bit manipulation (B = Zba + Zbb + Zbs)
- **Zba:** SH1ADD, SH2ADD, SH3ADD (RV64: ADD.UW, SHnADD.UW, SLLI.UW).
- **Zbb:** ANDN, ORN, XNOR, CLZ, CTZ, CPOP, MAX[U], MIN[U], SEXT.B, SEXT.H, ZEXT.H, ROL, ROR, RORI, ORC.B, REV8 (RV64 adds the …W forms).
- **Zbc:** CLMUL, CLMULH, CLMULR. **Zbs:** BCLR[I], BEXT[I], BINV[I], BSET[I].

#### Scalar crypto (Zk family, November 2021)
Zbkb, Zbkc, Zbkx, Zkne/Zknd (AES), Zknh (SHA-256/512), Zksed (SM4), Zksh (SM3), Zkr (seed CSR), Zkt (constant-time).\[10\] **Zkn** = Zbkb+Zbkc+Zbkx+Zkne+Zknd+Zknh; **Zks** = Zbkb+Zbkc+Zbkx+Zksed+Zksh; **Zk** = Zkn+Zkr+Zkt.

#### V: vectors (RVV 1.0)
- **State:** v0–v31, each VLEN bits (implementation-chosen, so code is length-agnostic); v0 doubles as the mask.\[16\] CSRs vstart, vxsat, vxrm, vcsr, vl, vtype, vlenb.
- **Configuration:** VSETVLI, VSETIVLI, VSETVL set SEW, LMUL, tail/mask policies and vl.
- **Classes:** unit-stride/strided/indexed/segment/whole-register loads and stores; integer, fixed-point and FP arithmetic on OP-V `1010111` (.vv/.vx/.vi/.vf); widening/narrowing; reductions; mask ops; permutations. Several hundred mnemonics: generate them from riscv-opcodes.
- **Sub-extensions:** Zvfh/Zvfhmin, Zvfbfmin/Zvfbfwma, and **Vector Crypto (September 2023):** Zvbb, Zvbc, Zvkb, Zvkg, Zvkned, Zvknha/b, Zvksed, Zvksh, Zvkt, plus bundles Zvkn/Zvknc/Zvkng/Zvks/Zvksc/Zvksg.\[10\]

Also list Ztso (January 2023) and the profile "capability" extensions (Zic64b, Ziccif, Ziccrse, Ziccamoa, Zicclsm, Za64rs).

### 2.6 Profiles

- **RVI20U32/U64:** bare base only. **RVA20U64:** RV64GC-class.
- **RVA22U64:** adds Zihpm, Zihintpause, Zba/Zbb/Zbs, Zicbom/Zicbop/Zicboz, Zfhmin, Zkt and others; V and scalar crypto were *options*.
- **RVA23U64 (ratified by the RISC-V Board of Directors' final vote, announced by RISC-V International on October 22, 2024):** makes **V** mandatory and adds **Zimop, Zcmop, Zcb, Zfa, Zawrs**, Zicond, Zvbb and others. **RVA23S64** also mandates the **Hypervisor (via the "Sha" bundle)** plus Sstvala, Sscofpmf, Ssnpm and more. Scalar crypto Zkn/Zks are no longer options in RVA23 (vector crypto is preferred). At ratification, Google's Lars Bergstrom (Director of Engineering) said RVA23 "is now the baseline requirement for the Android RISC-V Application Binary Interface (ABI)."
- **RVB23:** sibling family for more customizable application processors (e.g., embedded Linux).

### 2.7 Architectural state reference

| Reg | ABI | Role | Saved by |
|---|---|---|---|
| x0 | zero | hardwired 0; writes ignored | – |
| x1 | ra | return address | caller |
| x2 | sp | stack pointer (16-byte aligned) | callee |
| x3 | gp | global pointer | – |
| x4 | tp | thread pointer | – |
| x5–x7 | t0–t2 | temporaries | caller |
| x8 | s0/fp | saved / frame pointer | callee |
| x9 | s1 | saved | callee |
| x10–x11 | a0–a1 | arguments / return values | caller |
| x12–x17 | a2–a7 | arguments (a7 = syscall number by convention) | caller |
| x18–x27 | s2–s11 | saved | callee |
| x28–x31 | t3–t6 | temporaries | caller |
| pc | – | program counter (not a GPR) | – |

**FP registers:** ft0–ft7 (f0–f7), fs0–fs1 (f8–f9), fa0–fa1 (f10–f11, args/return), fa2–fa7 (f12–f17), fs2–fs11 (f18–f27), ft8–ft11 (f28–f31). **fcsr** (0x003) = frm (0x002: RNE, RTZ, RDN, RUP, RMM, DYN) + fflags (0x001).

| Level | Key CSRs (address) |
|---|---|
| Unprivileged | fflags 0x001, frm 0x002, fcsr 0x003, seed 0x015, cycle 0xC00, time 0xC01, instret 0xC02, vl 0xC20, vtype 0xC21, vlenb 0xC22 |
| Supervisor | sstatus 0x100, sie 0x104, stvec 0x105, sscratch 0x140, sepc 0x141, scause 0x142, stval 0x143, sip 0x144, stimecmp 0x14D, satp 0x180 |
| Machine info | mvendorid 0xF11, marchid 0xF12, mimpid 0xF13, **mhartid 0xF14** |
| Machine trap | **mstatus 0x300**, **misa 0x301**, medeleg 0x302, mideleg 0x303, **mie 0x304**, **mtvec 0x305**, mscratch 0x340, **mepc 0x341**, **mcause 0x342**, **mtval 0x343**, **mip 0x344** |
| Protection / counters | pmpcfg0–15 0x3A0–0x3AF, pmpaddr0–63 0x3B0–0x3EF, **mcycle 0xB00**, **minstret 0xB02**, mcountinhibit 0x320 |

**mstatus fields to visualize:** SIE (1), MIE (3), SPIE (5), MPIE (7), SPP (8), MPP (12:11), FS (14:13), MPRV (17), SUM (18), MXR (19), TVM, TW, TSR, SD. **misa:** MXL plus one bit per letter (bit 8 = I, bit 12 = M).

### 2.8 Privileged architecture essentials

- **Modes:** M (level 3, always present), S (1), U (0); H adds VS/VU.
- **Trap entry (to M):** `mepc ← pc`, `mcause ← {interrupt bit, code}`, `mtval ← faulting address/instruction or 0`, `MPIE ← MIE`, `MIE ← 0`, `MPP ← current mode`, `pc ← mtvec.BASE` (or `BASE + 4×cause` for vectored interrupts). medeleg/mideleg delegate traps to S-mode.
- **MRET:** `mode ← MPP`, `MIE ← MPIE`, `MPIE ← 1`, `pc ← mepc`. **ECALL handlers must do mepc += 4**, or ECALL re-executes forever, a perfect "spot the mistake" exercise.
- **Exception codes:** 0 instr. misaligned, 1 instr. access fault, 2 illegal instruction, 3 breakpoint, 4 load misaligned, 5 load access fault, 6 store misaligned, 7 store access fault, 8/9/11 ECALL from U/S/M, 12/13/15 instruction/load/store page fault. **Interrupts:** 1 SSI, 3 MSI, 5 STI, 7 MTI, 9 SEI, 11 MEI. Also SRET (`0x10200073`), MRET (`0x30200073`), WFI (`0x10500073`), SFENCE.VMA.
- **Virtual memory (satp.MODE):** **Sv32** (2-level, 10+10+12, 4 KiB/4 MiB pages), **Sv39** (3-level, 9+9+9+12), **Sv48** (4-level), **Sv57** (5-level). PTE bits V, R, W, X, U, G, A, D, RSW, PPN; R=W=X=0 points to the next level.
- **PMP:** up to 64 regions, modes OFF/TOR/NA4/NAPOT, R/W/X and a Lock bit; Sspmp (2026) brings PMP to S-mode.
- **Memory model:** **RVWMO** (FENCE and aq/rl), optional **Ztso**; **little-endian**, byte-addressed. Misaligned accesses may be handled in hardware, emulated, or trapped depending on the environment; for the MVP, trap so it's visible.

### 2.9 Standard pseudo-instructions

| Pseudo | Expansion |
|---|---|
| nop | addi x0, x0, 0 |
| li rd, imm | addi rd, x0, imm, or lui rd, (imm+0x800)>>12 ; addi rd, rd, lo12 |
| la rd, sym | auipc rd, %pcrel_hi(sym) ; addi rd, rd, %pcrel_lo(…) |
| mv / not / neg | addi rd, rs, 0 / xori rd, rs, −1 / sub rd, x0, rs |
| sext.w | addiw rd, rs, 0 |
| seqz / snez / sltz / sgtz | sltiu rd, rs, 1 / sltu rd, x0, rs / slt rd, rs, x0 / slt rd, x0, rs |
| beqz / bnez | beq / bne rs, x0, off |
| blez / bgez / bltz / bgtz | bge x0, rs / bge rs, x0 / blt rs, x0 / blt x0, rs |
| bgt / ble / bgtu / bleu | blt / bge / bltu / bgeu with operands swapped |
| j / jal off | jal x0, off / jal x1, off |
| jr / jalr rs | jalr x0, 0(rs) / jalr x1, 0(rs) |
| ret | jalr x0, 0(x1) |
| call / tail sym | auipc x1, hi ; jalr x1, lo(x1) / auipc x6, hi ; jalr x0, lo(x6) |
| fence | fence iorw, iorw |
| csrr / csrw / csrs / csrc | csrrs rd, csr, x0 / csrrw x0, csr, rs / csrrs x0 / csrrc x0 |
| rdcycle / rdtime / rdinstret | csrrs rd, cycle/time/instret, x0 |
| fmv.s / fabs.s / fneg.s | fsgnj.s / fsgnjx.s / fsgnjn.s rd, rs, rs |

Always show the expansion as a "ghost" line under the pseudo-instruction and animate the real instructions.

### 2.10 Assembler syntax, directives and ABIs

- **Syntax:** `label:`, `# comment`, `offset(rs1)` memory operands, registers by number or ABI name; relocations `%hi`, `%lo`, `%pcrel_hi`, `%pcrel_lo`.
- **Directives (MVP):** .text .data .rodata .bss .section .globl .align .byte .half .word .dword .string .asciz .zero .space .equ; later .option, .macro.
- **ABIs:** ilp32, ilp32f, ilp32d, ilp32e (RV32); lp64, lp64f, lp64d (RV64). `-march=rv64gc -mabi=lp64d` is the Linux standard; `rv32imac/ilp32` is typical embedded.
- **Educational syscalls** (RARS/Venus heritage): a7 = service number, a0–a2 = arguments; Venus copies SPIM-style calls through a0.\[17\] Label this "simulator environment, not ISA".

---

## 3. Microarchitecture to Visualize

### 3.1 Single-cycle datapath (animate this first)

**Components:** PC; PC+4 adder; instruction memory; register file (2 read, 1 write, x0 hardwired); immediate generator; main control; ALU control; ALU; branch target adder; branch comparator; data memory (width select, sign/zero extension); muxes ALUSrcA (rs1/PC/0), ALUSrcB (rs2/imm), WBSel (ALU/Mem/PC+4), PCSel (PC+4/branch/jalr).

*Patterson & Hennessy (RISC-V Edition) main control:*

| Instr | ALUSrc | MemtoReg | RegWrite | MemRead | MemWrite | Branch | ALUOp1 | ALUOp0 |
|---|---|---|---|---|---|---|---|---|
| R-format | 0 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| ld/lw | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| sd/sw | 1 | X | 0 | 0 | 1 | 0 | 0 | 0 |
| beq | 0 | X | 0 | 0 | 0 | 1 | 0 | 1 |

ALUOp 00 = add, 01 = subtract, 10 = use funct fields; ALU control 0000 AND, 0001 OR, 0010 add, 0110 sub. Harris & Harris use different names (ImmSrc 00 I/01 S/10 B/11 J; ResultSrc 00 ALU/01 memory/10 PC+4; a Jump signal for jal).

**The app's full RV32I control vector:**

| Class | RegWrite | ImmSel | ALUSrcA | ALUSrcB | ALUOp | MemRead | MemWrite | WBSel | PCSel |
|---|---|---|---|---|---|---|---|---|---|
| R | 1 | – | rs1 | rs2 | funct3/7 | 0 | 0 | ALU | PC+4 |
| I-ALU | 1 | I | rs1 | imm | funct3(/7) | 0 | 0 | ALU | PC+4 |
| Load | 1 | I | rs1 | imm | ADD | 1 | 0 | MEM | PC+4 |
| Store | 0 | S | rs1 | imm | ADD | 0 | 1 | – | PC+4 |
| Branch | 0 | B | rs1 | rs2 → comparator | compare | 0 | 0 | – | taken ? PC+imm : PC+4 |
| jal | 1 | J | PC | imm | ADD | 0 | 0 | PC+4 | PC+imm |
| jalr | 1 | I | rs1 | imm | ADD, &~1 | 0 | 0 | PC+4 | (rs1+imm)&~1 |
| lui | 1 | U | 0 | imm | ADD | 0 | 0 | ALU | PC+4 |
| auipc | 1 | U | PC | imm | ADD | 0 | 0 | ALU | PC+4 |
| ecall/ebreak | 0 | – | – | – | – | 0 | 0 | – | trap → mtvec |

**Data flow per type (animation scripts):**
- **add x5, x6, x7:** PC → IMEM → fields split; x6/x7 values travel to the ALU; sum flows through WBSel to x5; PC+4 → PC.
- **addi:** ImmGen sign-extends inst[31:20] (animate bit-31 copies); ALUSrcB selects imm.
- **lw x5, 8(x6):** ALU computes x6+8 → DMEM; four bytes read (show little-endian order) → x5.
- **sw x5, 8(x6):** rs2 value goes to DMEM write-data; memory cells update; write port dims.
- **beq:** comparator checks equality while the branch adder computes PC+immB; the losing PC path fades.
- **jal / jalr:** PC+immJ (or (rs1+imm)&~1) → PC; PC+4 → rd. With rd = x0 the value hits a "zero wall".
- **lui / auipc:** immU → rd, or PC + immU → rd (pair with addi to explain `la`).

### 3.2 Multi-cycle and 5-stage pipeline

- **Multi-cycle:** one memory and ALU reused over 3–5 steps by an FSM controller; explains why clock period equals the longest path and the CPI × cycle-time trade-off.
- **Pipeline:** IF → **IF/ID** → ID → **ID/EX** → EX → **EX/MEM** → MEM → **MEM/WB** → WB. Control signals generated in ID ride along with the instruction (show a colored "control backpack").
- **Forwarding (P&H):** EX hazard: `EX/MEM.RegWrite && EX/MEM.rd ≠ 0 && EX/MEM.rd == ID/EX.rs1 → ForwardA = 10`; MEM hazard: `MEM/WB.RegWrite && MEM/WB.rd ≠ 0 && !(EX hazard) && MEM/WB.rd == ID/EX.rs1 → ForwardA = 01` (same for rs2). The register file writes in the first half-cycle and reads in the second.
- **Load-use stall:** `ID/EX.MemRead && (ID/EX.rd == IF/ID.rs1 || ID/EX.rd == IF/ID.rs2)` → hold PC and IF/ID, zero ID/EX control (render a hollow grey bubble).
- **Control hazards:** predict not-taken, flush on misprediction; then 1-bit/2-bit predictors (animate the 4-state FSM), BTB, return-address stack.
- **How Ripes does it:** models from single-cycle through 5-stage with/without forwarding and hazard units, mux-selection and write-enable visualization, a pipeline table, and undoable clock cycles.\[5\]\[18\] Its weaknesses for novices are a dense static schematic, no narration and no encoding animation. Konata-style diagrams (instructions × cycles) are the standard for longer traces; generate one from your trace as a second view.\[19\]

### 3.3 Advanced topics and real cores
Caches (tag/index/offset with the same bit-field coloring, set-associativity, write-back, LRU); out-of-order execution (renaming, reservation stations, ROB, Tomasulo; prior art: FREESS and the Brno web superscalar simulator).\[20\]\[21\] Real cores as "field trips": **Rocket** (Berkeley, Chisel, 5-stage in-order), **BOOM** (superscalar out-of-order), **CVA6** (6-stage, Linux-capable), **Ibex** (2-stage), **PicoRV32** (size-optimized multi-cycle), **SERV** (bit-serial, among the smallest).\[22\]

### 3.4 Recommended learning progression
1. Bits, hex, two's complement, sign extension. 2. Registers and byte-addressed little-endian memory. 3. Instruction encoding. 4. One instruction on the single-cycle datapath (all 9 classes). 5. Programs, calls, stack frames. 6. Multi-cycle → pipeline. 7. Hazards and prediction. 8. Traps, CSRs, privilege, interrupts. 9. Virtual memory (Sv32 walk, TLB). 10. Caches → OoO → real cores.

---

## 4. Prior Art

| Tool | Type / link | Does well | Weak for learners |
|---|---|---|---|
| **Ripes** (Morten Borup Petersen) | Qt desktop + WASM (ripes.me), MIT | Single-cycle → 5-stage → dual-issue models; reversible stepping; cache sim. The Wildcat (DTU) authors say it "seems to have become the most used RISC-V simulator to teach computer architecture"\[22\]\[23\]\[24\] | Dense schematic, no narration, no encoding animation |
| **RARS / @specy/risc-v** | Java desktop; TS/JS build (MIT per npm listing) | Solid assembler, syscalls; embeddable with step-back, active in 2026\[3\]\[25\] | No datapath |
| **Venus** (CS61C) | Kotlin→JS web, MIT, venus.cs61c.org | Zero-install RV32IM, big course\[20\]\[26\]\[27\] | No datapath |
| **emulsiV** (ESEO) | JS web, MPL-2.0 | **Animates data transfers between units**, split into fetch, decode, ALU, mem/reg, PC steps; closest to your idea | Minimal RV32I subset; no pipeline; 2D\[28\]\[29\] |
| **WebRISC-V** (Siena) | PHP + JS, BSD-3-Clause, RV64IM | Cycle-by-cycle pipeline with forwarding; auto pipeline diagrams\[30\]\[31\]\[32\] | Server-side; dated UI |
| **CREATOR** (UC3M) | Vue + WASM, LGPL-3.0; v6.1 (March 2026) full RV32/RV64 via Sail | Didactic IDE, ESP32 upload\[33\]\[34\] | No datapath animation |
| **Jupiter, Cornell interpreter, CPUlator** | Desktop/web ISA simulators | Fast feedback, polished debugging | No microarchitecture |
| **Konata** | Pipeline trace viewer | Standard for long OoO traces\[35\] | Expert tool |
| **Spike / QEMU** | Reference simulator / emulator | Golden reference for tests | Non-visual |
| **TinyEMU / JSLinux** | C→WASM, MIT, RV128IMAFDQC | Boots Linux in a browser\[36\]\[37\] | No pedagogy |
| **Logisim-evolution, Digital, nand2tetris, Nandgame, Turing Complete** | Gate-level builders/games | Learners construct the CPU (highest engagement) | Steep or toy ISAs |
| **VisUAL, MARS, Little Man Computer, Visual 6502** | Classic simulators | Metaphors (LMC mailroom), transistor-level realism | Old ISAs; 2D |
| **Ben Eater, Branch Education, 3Blue1Brown, Ciechanowski, Explorable Explanations** | Videos / interactive essays | Narrative causality, beautiful motion, manipulable figures | Passive (videos) or not simulators |
| **SonicRV, Brno sim, FREESS** | Academic web simulators | Single/multicycle/pipeline; superscalar\[20\]\[21\]\[38\] | Small user bases |

**Lessons:** what works is packets moving along wires, highlighting only the active path, color-coded bit fields, pipeline tables, and step-back. What confuses learners: everything lit at once, unexplained mux selects, hex-only values, pseudo vs real instructions, PC-relative offsets, x0 eating writes, sign extension, little-endian memory views. **Your gap:** animated assembly→encoding→decode, narration tied to exact values, a modern 2.5D UI, one app from bits to traps, and predict-then-reveal interactions.

---

## 5. Pedagogy and Animation Design

### 5.1 What the evidence says
- **Animations help, modestly.** Höffler & Leutner (2007), 26 studies/76 comparisons: mean advantage **d = 0.37** over static pictures, d = 0.40 for *representational* animation.\[39\]\[40\] A later meta-analysis by Berney & Bétrancourt (2016, *Computers & Education*; 61 studies, 140 comparisons) found a smaller pooled effect of g = 0.226 (95% CI 0.12–0.33).
- **Animation alone is not the active ingredient.** Tversky, Morrison & Bétrancourt (2002) found many apparent benefits came from extra information or interactivity rather than motion, and that animations are often too complex or too fast; learner control and re-inspection are the promising uses.\[2\]\[41\]
- **Engagement beats spectacle.** In Hundhausen, Douglas & Stasko's meta-study, only 11 of 24 experiments yielded a significant result, and they concluded that "how students use AV technology has a greater impact on effectiveness than what AV technology shows them." Naps et al.'s engagement taxonomy (viewing → responding → changing → constructing → presenting) is your design ladder.\[42\]\[43\]
- **Mayer's multimedia principles:** segmenting, signaling, pre-training, spatial contiguity, coherence, modality; plus dual coding (pair visuals with "x6 + 10 = 0x0000002A" captions).

### 5.2 Design rules
1. **Default to step mode.** Each micro-step is a 300–900 ms segment ending in a captioned pause.
2. **Predict before reveal** ("Which register changes?" "Taken or not?").
3. **Progressive disclosure:** hide control wires at level 1, show a control box at level 2, every signal at level 3.
4. **One focus at a time:** dim inactive parts to about 20% opacity; bloom only active wires.
5. **Let learners change and construct:** edit registers, toggle forwarding, later wire a mux.
6. **3D only where depth means something:** pipeline walls, memory hierarchy, privilege rings, page-table levels.

### 5.3 Choreography spec (`addi t1, t1, 10`, t1 = 32)

| # | Segment | Visual | Narration |
|---|---|---|---|
| 0 | Assemble | Tokens fly into a colored 32-bit strip; hex appears | "I-type: imm, rs1, funct3 = 000, rd, opcode 0010011 → 0x00A30313." |
| 1 | Fetch | PC pulses to IMEM; PC+4 computes in parallel | "The PC addresses instruction memory." |
| 2 | Decode | Fields split; Control lights RegWrite = 1, ALUSrc = imm, WBSel = ALU | "Control recognizes OP-IMM." |
| 3 | Reg read | x6 value 32 travels out | "t1 holds 32." |
| 4 | Immediate | Bits 31:20 slide into ImmGen; bit 31 fills the top | "Sign-extend 10 → 0x0000000A." |
| 5 | Execute | Operands enter ALU; optional binary carry ripple | "32 + 10 = 42." |
| 6 | Memory | DMEM greyed | "No memory access." |
| 7 | Write back | Result reaches x6, which flashes 32 → 42 | "t1 ← 42." |
| 8 | PC update | PC+4 → PC | "Next instruction at 0x00000004." |

**Controls:** play/pause, step by segment or instruction, scrub bar with ticks, speed 0.25×–4×, replay segment, "explain this step" Sheet with spec links, and a skip-animation toggle.

### 5.4 Beginner modules
Binary and place value; hex; two's complement (wheel, overflow); sign vs zero extension; byte addressing and alignment; little-endian (0x12345678 stored as 78 56 34 12); fetch-decode-execute; clock edges; RISC vs CISC (fixed-length load/store vs x86 variable length); why RISC-V is open and modular (free ISA, frozen base plus extensions, profiles).

---

## 6. Technical Architecture

### 6.1 Stack
- **Vite + React 19 + TypeScript (strict)** SPA on static hosting; add Next.js only if you want SSR lesson pages.
- **3D:** `three`, `@react-three/fiber@9`, `@react-three/drei` (Line, Text, Html, Instances, OrthographicCamera, CameraControls, AdaptiveDpr), `@react-three/postprocessing`.
- **State:** zustand; the simulator is a pure reducer; XState optional for lesson flow.
- **Animation:** GSAP 3.13+ driven by your trace; per GSAP's 3.13 release notes, GSAP is "100% FREE including ALL of the bonus plugins… even for commercial use" (announced April 30, 2025). Theatre.js (`@theatre/r3f`) is useful for hand-keyframed camera tours, played via `sheet.sequence.position`.\[44\]
- **Editor:** CodeMirror 6 (light, mobile-friendly, easy RISC-V grammar, gutter markers); Monaco is heavier.
- **Testing:** Vitest + Playwright.

### 6.2 Folder structure
```
src/
  isa/    gen/instr_dict.json, instructions.ts, csr.ts, pseudo.ts
  sim/    decode.ts imm.ts execute.ts memory.ts trace.ts cpu-single.ts cpu-pipeline.ts
  asm/    lexer, parser, pseudo expansion, two-pass assembler, disassembler
  anim/   choreography templates, timeline compiler
  scene/  R3F: Board, Unit, Wire, Packet, Labels, CameraRig
  ui/     shadcn panels: Editor, Registers, Memory, Encoding, Narration, Controls
  lessons/ chapter scripts, quizzes
```

### 6.3 Simulator core
- **32-bit arithmetic:** `Int32Array(32)` registers, `|0` (signed) and `>>> 0` (unsigned), `Math.imul`; BigInt for MULH* and RV64 behind an XLEN abstraction. Force x0 to 0 after every write.
- **Decoding** (`w = word | 0` so `>>` sign-extends):
```ts
const opcode = w & 0x7f, rd = (w >>> 7) & 31, f3 = (w >>> 12) & 7,
      rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31, f7 = w >>> 25;
const immI = w >> 20;
const immS = ((w >> 25) << 5) | ((w >>> 7) & 0x1f);
const immB = ((w >> 31) << 12) | (((w >>> 7) & 1) << 11) |
             (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1);
const immU = w & 0xfffff000;
const immJ = ((w >> 31) << 20) | (((w >>> 12) & 0xff) << 12) |
             (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1);
```
  Match with riscv-opcodes pairs: `(w & mask) === match`.
- **Memory:** `ArrayBuffer` + `DataView` (little-endian) or sparse 4 KiB pages; emit misaligned/access-fault events instead of throwing.
- **Trace events:** `FETCH`, `DECODE {fields, ctrl}`, `REG_READ {port, reg, value}`, `IMM {format, value}`, `MUX {id, sel}`, `ALU {op, a, b, out}`, `BRANCH {taken, target}`, `MEM_READ/MEM_WRITE {addr, size, value}`, `REG_WRITE {reg, old, value}`, `PC {old, next}`, `TRAP {cause, tval, vector}`.
- **Assembler:** two passes (labels/directives/pseudo sizes, then resolve and encode), a source map for highlighting, and friendly errors ("immediate 5000 doesn't fit in 12 bits; use li"). The disassembler inverts the table with an aliases toggle.

### 6.4 Build vs reuse

| Candidate | License | Use |
|---|---|---|
| `@specy/risc-v` (Specy/rars) | MIT (per npm listing; verify)\[25\] | **Differential oracle** |
| Venus | MIT\[26\] | Reference behavior |
| Ripes | MIT\[45\] | Pipeline timing reference; not a library |
| emulsiV | MPL-2.0\[29\] | Study step decomposition |
| CREATOR | LGPL-3.0\[33\] | Full-ISA reference |
| WebRISC-V | BSD-3-Clause\[30\] | Pipeline-diagram ideas |
| TinyEMU | MIT (SLIRP BSD-2)\[46\] | Future "boot Linux" page |
| riscv-online-asm (binutils→WASM)\[47\] | assume GPL-3.0 | CI-only gold encoder\[48\] |
| riscv-opcodes | data + generator | **Encoding source of truth** |

**Recommendation:** write your own RV32I decoder/executor/assembler (about 1.5–3k lines of TS); generate tables from riscv-opcodes; use `@specy/risc-v` and GNU as as oracles.

### 6.5 Data-driven instruction model
```ts
interface InstrDef {
  mnemonic: string; ext: string; xlen: (32|64)[]; format: Fmt;
  match: number; mask: number;               // from riscv-opcodes
  syntax: "rd, rs1, imm";                    // parser + tooltips
  semantics: (ctx: ExecCtx) => void;         // emits MicroEvents
  animClass: "R"|"I_ALU"|"LOAD"|"STORE"|"BRANCH"|"JAL"|"JALR"|"LUI"|"AUIPC"|"SYSTEM";
  summary: string; details: string;          // narration templates
  pseudoOf?: string[]; specRef: string;
}
const CHOREO = {
  I_ALU: ["assemble","fetch","decode","regRead1","immGen","alu","wbAlu","pcPlus4"],
  LOAD:  ["assemble","fetch","decode","regRead1","immGen","aluAddr","memRead","wbMem","pcPlus4"],
};
```
The compiler maps `(CHOREO[animClass], events)` to GSAP tweens on scene objects addressed by ID (e.g., `wire:alu->wbmux`); `xori` reuses `I_ALU` with no new code.

### 6.6 R3F scene patterns
- **Blocks and labels:** drei `RoundedBox` + `Text` (SDF). Reserve `Html` for a few tooltips: each `<Html>` mounts its own React root, and many of them (especially with raycast occlusion) hurt mobile performance.\[49\]\[50\]
- **Wires:** one precomputed curve per wire ID rendered with `TubeGeometry` or drei `Line`; packets sample `curve.getPointAt(t)`.
- **Packets:** an `InstancedMesh` pool positioned in `useFrame` by mutating refs, never setState per frame.\[51\]\[52\]
- **Glow:** `Selection`/`SelectiveBloom` so only active paths glow.
- **Camera:** `OrthographicCamera` + `CameraControls.setLookAt` for guided per-segment moves; free-explore toggle.
- **Performance:** `frameloop="demand"` with `invalidate()`, `AdaptiveDpr`, instancing, disposal, lazy-loaded canvas.\[53\]\[54\]

### 6.7 shadcn/ui layout
Resizable panels: left Editor + listing (address/hex); center 3D canvas with transport bar; right Tabs [Registers | Memory | CSRs | Encoding]; bottom narration strip with an "Explain" Sheet. Components: Command (⌘K instruction search), Tabs, Sheet/Drawer, Tooltip/HoverCard (bit fields, signals), Table (registers with hex/dec/bin ToggleGroup and change highlights), Slider (speed/scrub), Accordion (extension groups), Select (microarchitecture), Switch (forwarding, aliases), Badge, Dialog (quizzes), Sonner (traps), dark mode. On mobile, canvas on top and panels in a Drawer.

### 6.8 Testing (accuracy is a publishing requirement)
1. Encoding round-trips against GNU as for every InstrDef.
2. **riscv-tests** (BSD) `rv32ui`/`rv32um`, precompiled to hex in CI.\[55\]
3. **riscv-arch-test (ACT 4.0)**; note **RISCOF was archived in April 2026** in favor of ACT 4.0.\[56\]\[57\]
4. Differential random-instruction testing against `@specy/risc-v` or Spike commit logs.
5. Single-cycle and pipeline models must agree on architectural state; cycle counts should match Ripes.

### 6.9 Deployment and accessibility
Static hosting (GitHub Pages, Cloudflare Pages, Netlify, Vercel) with shareable URL-encoded programs. Respect `prefers-reduced-motion`, full keyboard control (Space, arrows, ⌘K), `aria-live` narration, a color-blind-safe palette with labels, and every 3D fact mirrored in side-panel text.

---

## 7. Phased Roadmap (about 15–20 hours/week)

| Phase | Scope | Estimate |
|---|---|---|
| **0. Foundations** | Read RV32I chapter + P&H/H&H single-cycle chapters; set up Vite/R3F/shadcn | 1–2 weeks |
| **1. MVP** | RV32I core, encoding visualizer, single-cycle 2.5D datapath with 9 choreographies, panels, step/scrub, narration; rv32ui passing | 6–8 weeks |
| **2. Programs** | Assembler, pseudo-instructions, breakpoints, M extension, calling-convention view, ecall console, share links | 3–5 weeks |
| **3. Pipeline** | Multi-cycle, 5-stage, forwarding, stalls, flushes, predictors, pipeline diagram | 6–8 weeks |
| **4. Privilege** | CSRs, M/U modes, traps, timer interrupt, optional Sv32 | 4–6 weeks |
| **5. Extensions** | C, A, F/D (IEEE-754 anatomy), B, then V | 8–12+ weeks |
| **6. Advanced** | Caches, OoO/Tomasulo/ROB, superscalar, real-core tour | 6–10 weeks |

A strong v1 (Phases 0–3) takes about 4–6 months part-time; the full roadmap about a year.

---

## 8. Key Sources and Links

- **Specs:** docs.riscv.org (Unprivileged/Privileged v20260120, RVA23 Profiles v1.0); github.com/riscv/riscv-isa-manual; RISC-V Tech Hub "Ratified ISA Extensions"; github.com/riscv/riscv-opcodes; riscv-non-isa/riscv-asm-manual; riscv-non-isa/riscv-elf-psabi-doc.
- **Textbooks:** Patterson & Hennessy, *Computer Organization and Design: RISC-V Edition*; Harris & Harris, *Digital Design and Computer Architecture: RISC-V Edition*; Patterson & Waterman, *The RISC-V Reader*.
- **Courses:** Berkeley CS61C (cs61c.org); MIT 6.004/6.191; ETH Zürich Digital Design and Computer Architecture (Onur Mutlu); Cornell CS3410.
- **Repos:** github.com/mortbopet/Ripes; github.com/ESEO-Tech/emulsiV; github.com/61c-teach/venus; github.com/Specy/rars; github.com/creatorsim/creator; github.com/Mariotti94/WebRISC-V; github.com/shioyadan/Konata; riscv-tests; riscv-arch-test; Spike; bellard.org/tinyemu.
- **Docs:** React Three Fiber (performance pitfalls, scaling performance), drei, postprocessing, GSAP, Theatre.js, CodeMirror 6, shadcn/ui.
- **Pedagogy:** Höffler & Leutner (2007) *Learning and Instruction* 17(6); Tversky, Morrison & Bétrancourt (2002) *IJHCS* 57(4); Hundhausen, Douglas & Stasko (2002) *JVLC* 13(3); Naps et al. (2002); Mayer, *Multimedia Learning*.\[1\]\[58\]\[59\]

---

## 9. Caveats

- **The ISA keeps moving.** Ratifications after the 20260120 manuals (Zalasr, Ziccid, Sspmp) aren't consolidated yet. Show spec-version metadata per instruction and regenerate from riscv-opcodes rather than trusting any hand-typed table, including these. Verify every encoding with automated tests before publishing.
- **Textbook control tables are teaching models.** P&H and H&H differ in names and bit assignments, and real cores decode very differently; label your datapath "a classic textbook implementation".
- **Some license details are secondhand** (the `@specy/risc-v` MIT license came from an npm mirror; riscv-online-asm is unverified and binutils is GPL). Check LICENSE files before bundling; GPL tools used only in CI avoid distribution obligations.
- **Pedagogy effect sizes are cross-domain averages**, mostly not computer architecture; validate with your own users via simple in-app quizzes.
- **Effort estimates are rough**; 3D polish and lesson writing usually take longer than the simulator.

## Sources

1. [Instructional animation versus static pictures: A meta-analysis - Leibniz Institute for Science and Mathematics Education](https://www.leibniz-ipn.de/en/research/publications/instructional-animation-versus-static-pictures-a-meta-analysis)
2. [(PDF) Animation: can it facilitate? (2002)](https://scispace.com/papers/animation-can-it-facilitate-34acokbps7)
3. [GitHub - Specy/rars: RISC-V Assembler and Runtime Simulator in java and JavaScript](https://github.com/Specy/rars)
4. [@specy/risc-v - npm](https://www.npmjs.com/package/@specy/risc-v)
5. [Ripes A Visual Computer Architecture Simulator](https://www.scribd.com/document/643903139/Ripes-A-Visual-Computer-Architecture-Simulator)
6. [The RISC-V Instruction Set Manual, Volume I :: RISC-V Ratified Specifications Library](https://docs.riscv.org/reference/isa/v20260120/unpriv/unpriv-index.html)
7. [The RISC-V Instruction Set Manual, Volume II :: RISC-V Ratified Specifications Library](https://docs.riscv.org/reference/isa/v20260120/priv/priv-index.html)
8. [The RISC-V Instruction Set Manual, Volume II Privileged Architecture](https://fast-mirror.isrc.ac.cn/ruyisdk/humans/docs/riscv-ratified-specs/riscv-privileged-v20260120.pdf)
9. [The RISC-V Instruction Set Manual](https://riscv.github.io/riscv-isa-manual/snapshot/spec/)
10. [Ratified ISA Extensions - Home - RISC-V Tech Hub](https://riscv.atlassian.net/wiki/spaces/HOME/pages/16154732/Ratified+Extensions)
11. [GitHub - riscv/riscv-opcodes: RISC-V Opcodes · GitHub](https://github.com/riscv/riscv-opcodes)
12. [instr\_dict should contain instruction format · Issue #149 · riscv/riscv-opcodes · GitHub](https://github.com/riscv/riscv-opcodes/issues/149)
13. [A list of RISC-V standard extensions · GitHub](https://gist.github.com/dominiksalvet/2a982235957012c51453139668e21fce)
14. [Visualizing the RISC-V Instruction Set · GitHub](https://gist.github.com/camel-cdr/bd5b197ab140ad6df259916df1439066)
15. [RISC-V extensions: what’s available and how to find them](https://research.redhat.com/blog/article/risc-v-extensions-whats-available-and-how-to-find-it/)
16. [RISC-V Extensions Explained: The ISA Alphabet](https://lucaberton.com/blog/risc-v-extensions-explained-isa-alphabet/)
17. [Venus Reference - CS 61C](https://inst.eecs.berkeley.edu/~cs61c/su21/resources/venus-reference/)
18. [Ripes: A Visual Computer Architecture Simulator](https://ieeexplore.ieee.org/document/9707149)
19. [Export pipeline traces in Konata format · Issue #79 · willmccallion/rvsim · GitHub](https://github.com/willmccallion/rvsim/issues/79)
20. [arxiv.org](https://arxiv.org/html/2411.07721v1)
21. [Ripes: A Visual Computer Architecture Simulator](https://www.researchgate.net/publication/363115322_Ripes_A_Visual_Computer_Architecture_Simulator)
22. [Wildcat: Educational RISC-V Microprocessors](https://arxiv.org/pdf/2502.20197)
23. [GitHub - mortbopet/Ripes: A graphical processor simulator and assembly editor for the RISC-V ISA · GitHub](https://github.com/mortbopet/Ripes)
24. [Releases · mortbopet/Ripes · GitHub](https://github.com/mortbopet/ripes/releases)
25. [@specy/risc-v](https://npm.io/package/@specy/risc-v)
26. [GitHub - 61c-teach/venus: RISC-V instruction set simulator built for education · GitHub](https://github.com/61c-teach/venus)
27. [github.com](https://github.com/chocopy/venus)
28. [emulsiV - Simulator for Virgule, a minimal processor based on the RISC-V architecture](https://riscuinho.github.io/emulsiV/doc/)
29. [github.com](https://github.com/ESEO-Tech/emulsiV)
30. [WebRISC-V: A 32/64-bit RISC-V pipeline simulation tool - ScienceDirect](https://www.sciencedirect.com/science/article/pii/S235271102200070X)
31. [(PDF) WebRISC-V: a Web-Based Education-Oriented RISC-V Pipeline Simulation Environment](https://www.researchgate.net/publication/334689055_WebRISC-V_a_Web-Based_Education-Oriented_RISC-V_Pipeline_Simulation_Environment)
32. [WebRISC-V: A 64-bit RISC-V Pipeline Simulator for Computer Architecture Classes](https://riscv-europe.org/summit/2025/media/proceedings/2025-05-15-RISC-V-Summit-Europe-P1.3.04-GIORGI-abstract.pdf)
33. [CREATOR: An integrated development environment for programming assembly in RISC-V architectures - ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2352711026002840)
34. [CREATOR - Assembly Programming Simulator](https://creatorsim.github.io/)
35. [Konata/README.md at master · shioyadan/Konata · GitHub](https://github.com/shioyadan/Konata/blob/master/README.md)
36. [tinyemu - MyNixOS](https://mynixos.com/nixpkgs/package/tinyemu)
37. [RISC-V (Linux) - emulators.org](https://emulators.org/emulator/riscv/)
38. [(PDF) CREATOR: An Educational Integrated Development Environment for RISC-V Programming](https://www.researchgate.net/publication/380971298_CREATOR_An_Educational_Integrated_Development_Environment_for_RISC-V_Programming)
39. [ERIC - EJ780451 - Instructional Animation versus Static Pictures: A Meta-Analysis, Learning and Instruction, 2007-Dec](https://eric.ed.gov/?id=EJ780451)
40. [Instructional animation versus static pictures: A meta-analysis - ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0959475207001077)
41. [Int. J. Human-Computer Studies (2002) 57, 247–262 doi:10.1006/ijhc.1017](https://hci.stanford.edu/courses/cs448b/papers/Tversky_AnimationFacilitate_IJHCS02.pdf)
42. [Algorithm Visualization in CS Education: Comparing Levels of Student Engagement](https://dl.acm.org/doi/pdf/10.1145/774833.774846)
43. [(PDF) Comparing Learning Performance of Students Using Algorithm Visualizations Collaboratively on Different Engagement Levels](https://www.researchgate.net/publication/220374936_Comparing_Learning_Performance_of_Students_Using_Algorithm_Visualizations_Collaboratively_on_Different_Engagement_Levels)
44. [Animate a Camera Fly-through on Scroll Using Theatre.js and React Three Fiber](https://tympanus.net/codrops/2023/02/14/animate-a-camera-fly-through-on-scroll-using-theatre-js-and-react-three-fiber/)
45. [Ripes — download, setup and alternatives](https://srclog.com/Ripes)
46. [TinyEMU/README.md at master · fernandotcl/TinyEMU · GitHub](https://github.com/fernandotcl/TinyEMU/blob/master/README.md)
47. [RISC-V Online Assembler](https://riscvasm.lucasteske.dev/)
48. [GitHub - racerxdl/riscv-online-asm: RISC-V Online Assembler using Emscripten, Gnu Binutils · GitHub](https://github.com/racerxdl/riscv-online-asm)
49. [Drei's "Html" component is not performant for large numbers · pmndrs/react-three-fiber · Discussion #3130 · GitHub](https://github.com/pmndrs/react-three-fiber/discussions/3130)
50. [HTML Tag low performance React - Questions - three.js forum](https://discourse.threejs.org/t/html-tag-low-performance-react/48917)
51. [Performance pitfalls - React Three Fiber](https://r3f.docs.pmnd.rs/advanced/pitfalls)
52. [React Three Fiber vs Three.js (2026): Key Differences & Which to Pick](https://www.creativedevjobs.com/blog/react-three-fiber-vs-threejs)
53. [React-Three-Fiber: Enhancing Scene Quality with Drei + Performance Tips](https://medium.com/@ertugrulyaman99/react-three-fiber-enhancing-scene-quality-with-drei-performance-tips-976ba3fba67a)
54. [Scaling performance - Introduction - React Three Fiber](https://r3f.docs.pmnd.rs/advanced/scaling-performance)
55. [riscv-tests/LICENSE at master · riscv-software-src/riscv-tests · GitHub](https://github.com/riscv-software-src/riscv-tests/blob/master/LICENSE)
56. [GitHub - riscv/riscv-arch-test: The RISC-V Architectural Certification Tests (ACTs) are a set of assembly language tests designed to certify that a design faithfully implements the RISC-V specification. · GitHub](https://github.com/riscv/riscv-arch-test)
57. [GitHub - riscv-software-src/riscof · GitHub](https://github.com/riscv-software-src/riscof)
58. [Christopher Hundhausen - Google Scholar](https://scholar.google.com/citations?user=jdmx_E8AAAAJ&hl=en)
59. [Animation: can it facilitate?: International Journal of Human-Computer Studies: Vol 57, No 4](https://dl.acm.org/doi/10.1006/ijhc.2002.1017)
