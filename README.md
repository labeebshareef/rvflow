# rvflow

**Inside the RISC-V processor.** An app for learning how RISC-V executes instructions. It animates them
step by step on a 2.5D datapath — as a single-cycle, a multi-cycle or a 5-stage pipelined
implementation — with narration tied to the exact values involved.

It is built from the blueprint in [`docs/`](docs/), which covers the design, the research behind it and
the roadmap.

## What it covers

| Area | Details |
|---|---|
| **ISA** | RV32I, M, A, F, D, C, Zicsr, Zifencei, B (Zba, Zbb, Zbc, Zbs), and a teaching subset of V |
| **Privilege** | M, S and U modes. CSRs (mstatus, misa, mtvec, mepc, mcause, mtval, mie/mip, medeleg/mideleg, counters, fcsr, vector CSRs…), traps and delegation, `mret`/`sret`/`wfi`, CLINT timer and software interrupts |
| **Implementations** | Single-cycle datapath; multi-cycle view (one step per clock, control FSM); 5-stage pipeline with forwarding on/off, load-use stalls, flushes, and four branch predictors (not-taken, taken, 1-bit and 2-bit BHT) |
| **Memory** | Configurable L1 instruction and data caches (size, block, associativity, LRU/FIFO/random, write-back or write-through, write-allocate), with 3C miss classification and AMAT |
| **Verification** | Encodings checked against llvm-mc; the official **riscv-tests**; random programs compared against **QEMU** |

The vector subset assumes VLEN = 128 and ELEN = 32. It supports SEW 8/16/32; LMUL from ¼ to 8;
masking with `v0.t`; unit-stride and strided loads/stores; integer arithmetic, compares, reductions,
slides, merges and moves; and the mask instructions. Tail and masked-off elements are left undisturbed.

## Features

- **The trace drives everything.** The simulator core is written from scratch in TypeScript. Each step
  returns micro-events (fetch, expand, decode, register/CSR/FP/vector reads and writes, ALU, FPU,
  vector lanes, memory, AMOs, traps) and an undo journal, so you can step backwards. Animations are
  compiled from these events and a choreography template for each instruction class
  (`src/anim/choreography.ts`).
- **Data-driven ISA.** Each instruction is one row in `src/isa/instructions.ts`: a bit layout, its
  fixed fields and its operand syntax. The assembler, decoder, disassembler, encoding view and
  animation are all generic over these rows.
- **Exact floating point.** IEEE-754 single and double precision is computed with BigInt
  (`src/sim/fpu.ts`). It supports all five rounding modes, subnormals, NaN-boxing and exact fflags.
- **Encoding view.** Shows colored bit fields for every format: R, R4, I, S, B, U, J, CSR, AMO and the
  vector formats. Compressed instructions appear as their 16-bit form plus the 32-bit instruction they
  expand to.
- **Panels:**
  - an editor with breakpoints, and a listing that shows pseudo-instruction expansions
  - integer, FP, CSR and vector registers, with the current privilege mode
  - little-endian memory and control signals
  - L1 caches
  - a Perf tab comparing single-cycle, multi-cycle and pipeline timing
  - a console for program output
- **Pipeline view.** Shows the 5-stage pipeline in 3D, with pipeline registers drawn as walls. It
  displays forwarding arcs, bubbles, flushes and a cycles × instructions diagram, and lets you step
  forward or back one cycle at a time.
- **Run real binaries.** "ELF" loads any 32-bit RISC-V ELF. One with a `tohost` symbol runs bare-metal
  (e.g. a file from `tests/riscv-tests/`); any other runs in a minimal Linux user-mode environment.
- **Lessons.** 23 example programs, from a single `addi` up to trap handlers, timer interrupts, user
  mode, FP rounding, strip-mined vector code, atomics, bit manipulation, compressed code, pipeline
  hazards, cache strides and a 47-check self-test.
- **Assembler.** Supports pseudo-instructions (including CSR, FP and vector shorthands),
  `.option rvc` auto-compression, explicit `c.*` instructions, numeric local labels, `.float`, `.double`
  and `.dword`, and error messages written for learners.
- **Accessibility and sharing.** Predict-then-reveal questions, share links, keyboard control
  (press `?`), `prefers-reduced-motion`, `aria-live` narration, dark/light themes, and a layout that
  works on phones.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # ~870 tests: encodings, semantics, riscv-tests, QEMU diffs, UI logic
npm run typecheck
npm run build      # static site in dist/
```

## Verification

The test suite needs no RISC-V toolchain. The reference data it uses is committed, and three scripts
regenerate it:

| Suite | Source of truth | Regenerate with |
|---|---|---|
| `src/isa/golden.test.ts` | 490 encodings from **llvm-mc** (every instruction row and compressed form, with varied operands); also round-trips through the disassembler | `npm run gen:golden` |
| `src/sim/riscv-tests.test.ts` | 136 official **riscv-tests**: rv32ui/um/ua/uc/uf/ud/mi/si and Zba/Zbb/Zbc/Zbs, built with clang + lld into `tests/riscv-tests/` (BSD-3-Clause, see the LICENSE there) | `npm run gen:riscv-tests` |
| `src/sim/difftest.test.ts` | 60 random programs (~260 instructions each, covering every extension) run under **qemu-riscv32 8.2**; the final x, f and v registers, fcsr, vl/vtype and memory must match exactly | `npm run gen:difftests` |

Every riscv-test passes except `rv32si-p-dirty`, which needs Sv32 virtual memory; `satp` is bare-only
in this simulator. `rv32ui-p-ma_data` runs with hardware misaligned access enabled, as it requires.

Two notes on adapting to the toolchains:

- `scripts/fix-riscv-test-asm.mjs` patches three GNU-as-only constructs so LLVM can assemble the
  tests: 64-bit `li` constants, `.weak` followed by `.global`, and the `tcontrol` CSR name.
- QEMU 8.2 writes the destination of a vector reduction even when vl = 0, which RVV 1.0 forbids. The
  random generator therefore keeps vl ≥ 1.

## Layout

```
src/
  isa/       instruction table, bit layouts, encode/decode, RVC, CSR names, llvm-mc golden data
  sim/       CPU (privilege, traps, CLINT), FPU, vector unit, memory, ELF loader, trace types
  asm/       two-pass assembler, disassembler
  anim/      choreography templates → timeline compiler (with multi-cycle stages)
  pipeline/  trace-driven 5-stage timing model
  cache/     cache simulator with 3C classification
  scene/     R3F scenes: single-cycle datapath (+ FP/vector lane), 5-stage pipeline
  store/     zustand store: playback clock, undo, implementation modes, derived views
  ui/        panels and small shadcn-style components
  lessons/   example programs
scripts/     generators for the golden encodings, riscv-tests and QEMU fixtures
tests/       committed ELF fixtures (riscv-tests, differential tests)
```

## Environments

- **Programs from the editor** start in M-mode. `.text` is at `0x0`, `.data` at `0x10000`, `sp` at
  `0x3FFF0`; FP and vector units are enabled.
  - With no trap handler (`mtvec = 0`), `ecall` provides RARS-style services (a7 = 1 print int,
    2 float, 3 double, 4 string, 11 char, 34 hex, 10/93 exit), and other traps stop the run with an
    explanation.
  - Once you install a handler with `csrw mtvec, …`, traps behave as on real hardware.
- **The CLINT** sits at `0x0200_0000`: msip, mtimecmp at `+0x4000`, mtime at `+0xBFF8`. `mtime` advances
  by one per instruction.
- **Bare-metal ELFs** (those with `tohost`) run from reset and stop when `tohost` is written.
- **Linux user-mode ELFs** support `write` (64) and `exit` (93).

## Scope

The datapath is labeled *a classic textbook implementation*. Control-signal names follow the
blueprint's RV32I table, and real cores decode differently.

Not implemented:

- Sv32 address translation and PMP enforcement (PMP CSRs are stored only)
- the H extension
- vector floating point and widening/narrowing vector instructions
- out-of-order execution

The pipeline model times the functional simulator's instruction stream, so every view always agrees on
architectural state.
