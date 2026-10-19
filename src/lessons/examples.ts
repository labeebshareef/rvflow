import selftest from "./selftest.s?raw";

/** Example programs, ordered as a learning progression. */
export interface Example {
  id: string;
  title: string;
  chapter: string;
  blurb: string;
  /** Initial register values applied after reset (by ABI name). */
  setup?: Record<string, number>;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    id: "addi",
    chapter: "1 · One instruction",
    title: "addi t1, t1, 10",
    blurb: "The blueprint's first animation: t1 starts at 32, one I-type instruction adds 10.",
    setup: { t1: 32 },
    source: `# One instruction, start to finish.
# t1 (x6) starts at 32. Step through each segment:
# assemble → fetch → decode → read → immediate → ALU → write back → PC.
    addi t1, t1, 10
`,
  },
  {
    id: "tour",
    chapter: "1 · One instruction",
    title: "Tour of all nine classes",
    blurb: "One instruction from every choreography class: R, I-ALU, load, store, branch, jal, jalr, lui, auipc.",
    source: `# One of each instruction class. Watch which units light up —
# and which ones go dark — for each.
    lui   t0, 0x10          # U-type: t0 = 0x00010000 (data segment)
    auipc t1, 0             # U-type: t1 = PC
    addi  a0, zero, 7       # I-type ALU
    add   a1, a0, a0        # R-type
    sw    a1, 0(t0)         # S-type store
    lw    a2, 0(t0)         # I-type load
    beq   a1, a2, same      # B-type branch (taken)
    addi  a0, zero, -1      # skipped
same:
    jal   ra, func          # J-type: call
    j     done
func:
    addi  a0, a0, 1
    jalr  zero, 0(ra)       # I-type jump: return
done:
    li    a7, 10
    ecall
`,
  },
  {
    id: "encoding",
    chapter: "2 · Encoding",
    title: "Formats & scrambled immediates",
    blurb: "Compare how S, B and J formats chop the immediate into pieces — watch the bit strip.",
    source: `# Same register numbers, different formats.
# Open the Encoding tab and compare the coloured fields.
    sw    t2, -8(sp)        # S: imm split as [11:5] | [4:0]
    lw    t2, -8(sp)        # I: imm in one piece [11:0]
    beq   t2, t2, next      # B: imm[12|10:5] … imm[4:1|11]
next:
    jal   zero, after       # J: imm[20|10:1|11|19:12]
after:
    lui   t2, 0xFFFFF       # U: top 20 bits
    srai  t2, t2, 4         # I*: imm[11:5] acts as funct7
`,
  },
  {
    id: "signs",
    chapter: "2 · Encoding",
    title: "Sign extension & x0",
    blurb: "Negative immediates fill with ones; writes to x0 vanish; li splits big constants.",
    source: `# Sign extension in action.
    addi t0, zero, -1       # imm 0xFFF → 0xFFFFFFFF
    addi t1, zero, 2047     # largest 12-bit immediate
    li   t2, 0x12345678     # too big: lui + addi
    li   t3, 0x00000800     # lui 0x1 + addi -2048 — why?
    addi zero, t1, 5        # writes to x0 are ignored
    sltiu a0, t1, -1        # -1 sign-extends, then compares unsigned
`,
  },
  {
    id: "endian",
    chapter: "3 · Memory",
    title: "Little-endian memory",
    blurb: "0x12345678 is stored as 78 56 34 12. Byte and halfword loads sign- or zero-extend.",
    source: `# Little-endian: least significant byte at the lowest address.
    la   t0, buf
    li   t1, 0x12345678
    sw   t1, 0(t0)          # memory: 78 56 34 12
    lbu  a0, 0(t0)          # 0x78
    lbu  a1, 3(t0)          # 0x12
    lh   a2, 0(t0)          # 0x5678
    li   t2, 0x80
    sb   t2, 4(t0)
    lb   a3, 4(t0)          # sign-extended: -128
    lbu  a4, 4(t0)          # zero-extended: 128
    li   a7, 10
    ecall
.data
buf: .zero 8
`,
  },
  {
    id: "loop",
    chapter: "4 · Programs",
    title: "Sum 1..10 (loop)",
    blurb: "A counted loop with a backward branch. Predict: taken or not?",
    source: `# Sum the numbers 1..10 into a0.
    li   a0, 0              # sum
    li   t0, 1              # i
    li   t1, 11             # limit
loop:
    add  a0, a0, t0         # sum += i
    addi t0, t0, 1          # i++
    blt  t0, t1, loop       # backward branch
    li   a7, 1              # print a0
    ecall
    li   a7, 10
    ecall
`,
  },
  {
    id: "fib",
    chapter: "4 · Programs",
    title: "Fibonacci with output",
    blurb: "Prints the first Fibonacci numbers using ecall services.",
    source: `# Print the first 12 Fibonacci numbers.
    li   s0, 0              # a
    li   s1, 1              # b
    li   s2, 12             # count
loop:
    mv   a0, s0
    li   a7, 1              # PrintInt
    ecall
    li   a0, ' '
    li   a7, 11             # PrintChar
    ecall
    add  t0, s0, s1
    mv   s0, s1
    mv   s1, t0
    addi s2, s2, -1
    bnez s2, loop
    li   a7, 10
    ecall
`,
  },
  {
    id: "call",
    chapter: "5 · Functions",
    title: "Call, stack frame, return",
    blurb: "A recursive factorial: ra and s0 saved on the stack, sp moves by 16.",
    source: `# factorial(5) recursively, following the calling convention.
main:
    li   a0, 5
    call fact               # auipc ra + jalr
    li   a7, 1
    ecall                   # prints 120
    li   a7, 10
    ecall

fact:                       # a0 = n → a0 = n!
    addi sp, sp, -16        # push frame
    sw   ra, 12(sp)
    sw   s0, 8(sp)
    mv   s0, a0
    li   t0, 1
    ble  a0, t0, base
    addi a0, a0, -1
    call fact
    mul  a0, a0, s0         # M extension
    j    out
base:
    li   a0, 1
out:
    lw   s0, 8(sp)
    lw   ra, 12(sp)
    addi sp, sp, 16         # pop frame
    ret
`,
  },
  {
    id: "hello",
    chapter: "5 · Functions",
    title: "Hello, string in .data",
    blurb: "la builds an address with auipc + addi; ecall 4 prints a zero-terminated string.",
    source: `.data
msg:  .string "Hello, RISC-V!\\n"
.text
main:
    la   a0, msg            # auipc + addi (PC-relative)
    li   a7, 4              # PrintString
    ecall
    li   a7, 10
    ecall
`,
  },
  {
    id: "muldiv",
    chapter: "6 · M extension",
    title: "Multiply & divide corner cases",
    blurb: "Division never traps: x/0 = -1, remainder x; INT_MIN / -1 overflows quietly.",
    source: `    li   t0, -7
    li   t1, 2
    mul  a0, t0, t1         # -14
    div  a1, t0, t1         # -3 (rounds toward zero)
    rem  a2, t0, t1         # -1 (sign of dividend)
    div  a3, t0, zero       # -1
    rem  a4, t0, zero       # -7
    li   t2, 0x80000000
    li   t3, -1
    div  a5, t2, t3         # 0x80000000 (overflow)
    mulh a6, t2, t2         # high word: 0x40000000
`,
  },
  {
    id: "bug",
    chapter: "7 · Traps",
    title: "Spot the mistake: misaligned load",
    blurb: "An odd address on lw raises a load-address-misaligned trap.",
    source: `    la   t0, data
    lw   a0, 0(t0)          # fine
    lw   a1, 2(t0)          # misaligned → trap (cause 4)
.data
data: .word 0xCAFEF00D, 0x12345678
`,
  },
  {
    id: "selftest",
    chapter: "8 · Testing",
    title: "Big self-test (47 checks)",
    blurb: "Exercises every instruction class, memory widths, branches, M corner cases, sorting, recursion and jalr; prints ok/FAIL per check.",
    source: selftest,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
