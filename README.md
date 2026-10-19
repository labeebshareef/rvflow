# rvflow

**Inside the RISC-V processor.** An app for learning how RISC-V executes instructions. It plays an animated
2.5D single-cycle datapath one narrated step at a time: assemble → fetch → decode → read registers →
immediate → ALU → memory → write back → update PC.

It is built from the blueprint in [`docs/`](docs/), which covers the design, the research behind it and
the roadmap.

## Features

- **RV32I + M simulator core** written from scratch in TypeScript. `step()` returns a *micro-event trace*:
  FETCH, DECODE, REG_READ, IMM, MUX, ALU, BRANCH, MEM_READ/WRITE, REG_WRITE, PC, TRAP. It also returns
  exact undo information, so you can step backwards.
- **The trace drives everything.** The animation timeline is compiled from those events and a
  choreography template for each instruction class (`src/anim/choreography.ts`). To add an instruction,
  you add a row to `src/isa/instructions.ts`. No new animation code is needed.
- **Animated encoding view.** Each instruction becomes a 32-bit word with colored fields. An
  immediate-generator panel shows how the scrambled B- and J-format bits fit back together.
- **2.5D datapath** (React Three Fiber). Glowing packets carry real values along the wires, unused units
  dim, and each mux shows which input it selected.
- **Learner-controlled playback.** Play, pause, step one segment or one instruction, step back, undo,
  scrub through the segments, speed from 0.25× to 4×, and "Explain this step".
- **Predict, then reveal.** Optional questions before a step is shown ("Which register will change?",
  "Will the branch be taken?"), with a running score.
- **Two-pass assembler.** Handles labels, `.text/.data`, `.word/.half/.byte/.string/.zero/.align/.equ`,
  `%hi/%lo/%pcrel_hi/%pcrel_lo`, and the standard pseudo-instructions (`li`, `la`, `mv`, `call`, `ret`,
  `beqz`, `bgt`, …). Errors are written to be helpful ("immediate 5000 doesn't fit … use li"), and the
  listing shows each pseudo-instruction's expansion as a ghost line.
- **Panels:** CodeMirror 6 editor with breakpoints, a machine-code listing, registers (hex/dec/udec/bin,
  ABI or x# names, change highlighting), a little-endian memory view, control signals, and a console
  for `ecall` output (RARS-style services).
- **Lessons:** 11 example programs arranged in chapters, from a single `addi` up to recursion and traps.
- **Share links** that carry the program in the URL. Keyboard shortcuts throughout (press `?`). Respects
  `prefers-reduced-motion`. Narration is announced through an `aria-live` region. Dark and light themes,
  a color-blind-safe palette, and a layout that works on phones.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest: encodings vs GNU as, semantics, assembler, choreography, store
npm run typecheck
npm run build      # static site in dist/ (relative base, so it can be hosted anywhere)
```

## Keyboard

| Key | Action |
|---|---|
| Space | Play / pause |
| → / Shift+→ | Next step / next instruction |
| ← / Shift+← | Back one step / undo instruction |
| E | Run to end or breakpoint |
| R | Reset |
| X | Explain this step |
| Ctrl/⌘+Enter | Assemble (in the editor) |

## Layout

```
src/
  isa/      instruction table (match/mask), encoders/decoders, register names
  sim/      ALU, control vector, sparse little-endian memory, CPU + trace types
  asm/      two-pass assembler with pseudo-instructions, disassembler
  anim/     choreography templates → timeline compiler
  scene/    R3F datapath: board layout, units, wires, packets
  store/    zustand store: playback clock, history/undo, derived "what is visible now"
  ui/       panels and small shadcn-style components (Radix + Tailwind)
  lessons/  example programs
```

## Memory map and environment

`.text` starts at `0x00000000` and `.data` at `0x00010000`. `sp` starts at `0x0003FFF0` and `gp` at
`0x00010800`. Execution starts at `_start` or `main` if either is defined, otherwise at address 0.
`ecall` services (a7 = 1 print int, 4 string, 11 char, 34 hex, 35 binary, 36 unsigned, 10/93 exit)
belong to the simulator environment, not to the ISA. Misaligned accesses, illegal instructions and
misaligned jump targets raise a trap, which stops the run and explains the cause.

## Scope and next steps

This is Phase 1 of the blueprint's roadmap plus parts of Phase 2: assembler, pseudo-instructions,
breakpoints, the M extension, console and share links. Not built yet: the multi-cycle and 5-stage
pipeline views, CSRs and privilege modes with real trap handlers, the C/A/F/D/B/V extensions, caches,
and differential testing against riscv-tests or `@specy/risc-v`. Encodings are currently checked
against reference words produced by GNU as (`src/isa/encoding.test.ts`).

The datapath is labeled *a classic textbook implementation*. Signal names follow the blueprint's RV32I
control table, and real cores decode differently.
