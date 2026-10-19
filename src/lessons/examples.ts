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
    id: "trap",
    chapter: "8 · Privilege & traps",
    title: "Your own trap handler",
    blurb: "Install mtvec, then watch ecall and a misaligned load trap into it; mret returns. Don't forget mepc += 4!",
    source: `# A machine-mode trap handler. Open Registers → CSR to watch mepc, mcause, mstatus.
main:
    la   t0, handler
    csrw mtvec, t0        # from now on, traps jump to handler
    li   a0, 20
    li   a7, 100          # our own "service 100": double a0
    ecall                 # trap: mcause = 11 (ecall from M-mode)
    mv   s0, a0           # 40
    la   t2, data
    lw   t3, 2(t2)        # misaligned: mcause = 4, the handler skips it
    csrw mtvec, zero      # remove the handler: ecall reaches the simulator's services again
    mv   a0, s0
    li   a7, 1
    ecall                 # prints 40
    li   a7, 10
    ecall

handler:
    csrr t0, mcause
    li   t1, 11
    bne  t0, t1, resume   # only ecall is a "service"
    slli a0, a0, 1
resume:
    csrr t0, mepc
    addi t0, t0, 4        # skip the trapping instruction (or it runs again forever)
    csrw mepc, t0
    mret

.data
data: .word 0x11223344, 0x55667788
`,
  },
  {
    id: "timer",
    chapter: "8 · Privilege & traps",
    title: "Timer interrupts",
    blurb: "Program the CLINT's mtimecmp, enable MTIE and MIE, and sleep in wfi until three ticks have arrived.",
    source: `# mtime counts up by one per instruction. When mtime ≥ mtimecmp, the
# machine timer interrupt (cause 7) is pending; with mie.MTIE and
# mstatus.MIE set, the next instruction boundary traps to mtvec.
.equ MTIME,    0x0200BFF8
.equ MTIMECMP, 0x02004000
main:
    la   t0, tick
    csrw mtvec, t0
    li   s0, 0                # ticks seen
    li   t0, MTIME
    lw   t1, 0(t0)
    addi t1, t1, 25
    li   t2, MTIMECMP
    sw   t1, 0(t2)            # first interrupt 25 "cycles" from now
    sw   zero, 4(t2)
    li   t0, 0x80
    csrs mie, t0              # MTIE: machine timer interrupt enable
    csrsi mstatus, 8          # MIE: global machine interrupt enable
wait:
    li   t3, 3
    bge  s0, t3, done
    wfi                       # sleep until an interrupt is pending
    j    wait
done:
    csrci mstatus, 8
    csrw mtvec, zero
    mv   a0, s0
    li   a7, 1
    ecall                     # prints 3
    li   a7, 10
    ecall

tick:                         # interrupt handler: mepc points at the interrupted instruction
    addi s0, s0, 1
    li   t0, MTIME
    lw   t1, 0(t0)
    addi t1, t1, 25
    li   t2, MTIMECMP
    sw   t1, 0(t2)            # re-arm the timer (this clears the pending bit)
    mret
`,
  },
  {
    id: "umode",
    chapter: "8 · Privilege & traps",
    title: "Dropping to user mode",
    blurb: "mret with MPP = U enters user mode; touching mstatus there is illegal, and ecall comes back to M-mode.",
    source: `# M-mode sets up a handler, then "returns" into user code.
main:
    la   t0, handler
    csrw mtvec, t0
    la   t0, user
    csrw mepc, t0
    li   t0, 0x1800           # mstatus.MPP (bits 12:11)
    csrc mstatus, t0          # MPP = 00: user mode
    mret                      # privilege drops to U

user:                         # the badge above the registers now shows U-mode
    li   a0, 7
    ecall                     # mcause 8: environment call from U-mode
    csrr t1, mstatus          # mcause 2: M-mode CSRs are off-limits in U-mode
    ecall

handler:                      # always runs in M-mode
    csrr t0, mcause
    slli s2, s2, 4
    or   s2, s2, t0           # remember each cause as a hex digit
    addi s3, s3, 1
    li   t1, 3
    beq  s3, t1, finish
    csrr t0, mepc
    addi t0, t0, 4
    csrw mepc, t0
    mret                      # MPP is still U: back to user mode
finish:
    csrw mtvec, zero
    mv   a0, s2
    li   a7, 34
    ecall                     # prints 0x00000828: ecall, illegal, ecall
    li   a7, 10
    ecall
`,
  },
  {
    id: "float",
    chapter: "9 · Floating point",
    title: "IEEE 754 in the FPU",
    blurb: "Single and double precision, NaN-boxing, rounding modes, and the sticky fflags (0.1 + 0.1 + 0.1 ≠ 0.3).",
    source: `# Watch the FP lane under the datapath, and Registers → f.
.data
x:     .float 1.5
       .align 3               # doubles must be 8-byte aligned
tenth: .double 0.1
.text
    la   t0, x
    flw  fa0, 0(t0)           # 1.5, NaN-boxed into a 64-bit register
    fadd.s fa1, fa0, fa0      # 3.0
    li   t1, 3
    fcvt.s.w fa2, t1          # integer 3 → 3.0
    feq.s s0, fa1, fa2        # 1: equal

    la   t0, tenth
    fld  fa3, 0(t0)
    fadd.d fa4, fa3, fa3
    fadd.d fa4, fa4, fa3      # 0.30000000000000004: not exactly 0.3
    csrr s1, fflags           # NX (inexact) is set and stays set

    li   t2, 1
    fcvt.s.w ft0, t2
    li   t2, 3
    fcvt.s.w ft1, t2
    fdiv.s ft2, ft0, ft1, rtz # 1/3 rounded toward zero
    fdiv.s ft3, ft0, ft1, rup # 1/3 rounded up
    fmv.x.w s2, ft2
    fmv.x.w s3, ft3
    sub  s4, s3, s2           # 1: the two results are one ulp apart

    fmv.w.x ft4, zero
    fdiv.s ft5, ft0, ft4      # 1/0 = +inf and raises DZ, but never traps
    fclass.s s5, ft5          # 0x80: positive infinity

    fmv.d fa2, fa4
    li   a7, 3
    ecall                     # PrintDouble (fa2): 0.30000000000000004
    li   a7, 10
    ecall
`,
  },
  {
    id: "vadd",
    chapter: "10 · Vectors",
    title: "Vector add, strip-mined",
    blurb: "vsetvli asks for n elements and gets vl back: the same loop works for any vector length.",
    source: `# c[i] = a[i] + b[i] for 10 elements, 4 at a time (VLEN = 128, SEW = 32).
.data
a: .word 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
b: .word 10, 20, 30, 40, 50, 60, 70, 80, 90, 100
c: .zero 40
.text
    li   a0, 10               # elements left
    la   a1, a
    la   a2, b
    la   a3, c
loop:
    vsetvli t0, a0, e32, m1, ta, ma   # t0 = vl = min(a0, VLMAX = 4)
    vle32.v v1, (a1)
    vle32.v v2, (a2)
    vadd.vv v3, v1, v2        # vl additions in parallel lanes
    vse32.v v3, (a3)
    sub  a0, a0, t0
    slli t1, t0, 2            # bytes processed
    add  a1, a1, t1
    add  a2, a2, t1
    add  a3, a3, t1
    bnez a0, loop             # last pass: vl = 2
    la   t2, c
    lw   a0, 36(t2)           # c[9] = 110
    li   a7, 1
    ecall
    li   a7, 10
    ecall
`,
  },
  {
    id: "vdot",
    chapter: "10 · Vectors",
    title: "Dot product: vmacc + vredsum",
    blurb: "Multiply-accumulate lane by lane, then fold the lanes into one number with a reduction.",
    source: `.data
x: .word 1, 2, 3, 4, 5, 6, 7, 8
y: .word 8, 7, 6, 5, 4, 3, 2, 1
.text
    li   a0, 8
    la   a1, x
    la   a2, y
    vsetvli t0, zero, e32, m1, ta, ma
    vmv.v.i v4, 0             # per-lane accumulators
loop:
    vsetvli t0, a0, e32, m1, tu, ma   # tu: keep the accumulators past vl
    vle32.v v1, (a1)
    vle32.v v2, (a2)
    vmacc.vv v4, v1, v2       # v4[i] += v1[i] * v2[i]
    sub  a0, a0, t0
    slli t1, t0, 2
    add  a1, a1, t1
    add  a2, a2, t1
    bnez a0, loop
    vsetvli t0, zero, e32, m1, ta, ma
    vmv.s.x v5, zero          # starting value 0
    vredsum.vs v6, v4, v5     # v6[0] = sum of all lanes
    vmv.x.s a0, v6            # 120
    li   a7, 1
    ecall
    li   a7, 10
    ecall
`,
  },
  {
    id: "atomics",
    chapter: "11 · Atomics, bits & compressed",
    title: "AMOs and an LR/SC lock",
    blurb: "amoadd/amoswap update memory indivisibly; lr.w/sc.w build a spin lock that retries if it loses the reservation.",
    source: `.data
counter: .word 0
lock:    .word 0
.text
    la   a0, counter
    li   t0, 5
    amoadd.w t1, t0, (a0)     # t1 = 0 (old), counter = 5
    amoadd.w t1, t0, (a0)     # t1 = 5, counter = 10
    amoswap.w t2, zero, (a0)  # t2 = 10, counter = 0

    la   a1, lock
acquire:
    lr.w t3, (a1)             # load and reserve
    bnez t3, acquire          # someone holds it: spin
    li   t4, 1
    sc.w t5, t4, (a1)         # store only if still reserved
    bnez t5, acquire          # t5 = 1: lost the reservation, retry
    amoadd.w zero, t0, (a0)   # critical section: counter += 5
    amoswap.w.rl zero, zero, (a1)   # release (rl orders earlier stores first)

    lw   a0, 0(a0)
    li   a7, 1
    ecall                     # prints 5
    li   a7, 10
    ecall
`,
  },
  {
    id: "bits",
    chapter: "11 · Atomics, bits & compressed",
    title: "Bit manipulation (B)",
    blurb: "cpop, clz, rev8, rotations, andn and sh2add — single instructions for jobs that used to take loops.",
    source: `.data
table: .word 100, 200, 300, 400
.text
    li   a0, 0xF0F00F0F
    cpop t0, a0               # 16 bits set
    li   a1, 0x00000100
    clz  t1, a1               # 23 leading zeros
    ctz  t2, a1               # 8 trailing zeros
    rev8 t3, a0               # 0x0F0FF0F0: byte swap (endianness)
    rori t4, a0, 4            # 0xFF0F00F0
    andn t5, a0, a1           # a0 & ~a1
    li   a2, 0x61626300       # "\\0cba" in memory order
    orc.b t6, a2              # 0xFFFFFF00: finds the zero byte (strlen trick)
    la   a3, table
    li   a4, 3
    sh2add a5, a4, a3         # &table[3] in one instruction
    lw   a0, 0(a5)            # 400
    max  a0, a0, t0
    li   a7, 1
    ecall
    li   a7, 10
    ecall
`,
  },
  {
    id: "rvc",
    chapter: "11 · Atomics, bits & compressed",
    title: "Compressed code (.option rvc)",
    blurb: "The assembler shrinks eligible instructions to 16 bits; watch the Expand step turn them back into 32-bit ones.",
    source: `.option rvc                  # compress what can be compressed
    li   a0, 0                # c.li
    li   a1, 10               # c.li
loop:
    addi a0, a0, 3            # c.addi
    addi a1, a1, -1           # c.addi
    bnez a1, loop             # branches stay 32-bit here
    mv   a2, a0               # c.mv
    add  a2, a2, a0           # c.add
    slli a2, a2, 1            # c.slli
    c.srli a2, 2              # explicit compressed form
    mv   a0, a2
    li   a7, 1                # c.li
    ecall                     # prints 30 (ecall has no 16-bit form)
    li   a7, 10
    ecall
.option norvc
`,
  },
  {
    id: "hazards",
    chapter: "12 · Microarchitecture",
    title: "Pipeline hazards",
    blurb: "Switch to Pipeline (top bar): forwarding, a load-use bubble, and a loop branch the predictor learns.",
    source: `# Choose "Pipeline" in the header, then step cycle by cycle.
# Try turning forwarding off, or switching the predictor.
.data
v: .word 21
.text
    li   t0, 1
    add  t1, t0, t0           # needs t0 right away: forwarded from EX/MEM
    add  t2, t1, t0           # t1 from EX/MEM, t0 from MEM/WB
    la   s0, v
    lw   t3, 0(s0)
    add  t4, t3, t3           # load-use hazard: one bubble even with forwarding
    li   t5, 6
loop:
    addi t5, t5, -1
    bnez t5, loop             # mispredicts until the 2-bit counter warms up
    mul  a0, t4, t2           # 42 × 3
    li   a7, 1
    ecall
    li   a7, 10
    ecall
`,
  },
  {
    id: "cache",
    chapter: "12 · Microarchitecture",
    title: "Caches: rows vs columns",
    blurb: "Sum a 16×16 matrix row by row, then set COLUMNS = 1: same work, very different D-cache hit rate (Cache tab).",
    source: `# Run to the end (E), then open the Cache tab. Change COLUMNS to 1 and compare.
.equ N, 16
.equ COLUMNS, 0
.data
m: .zero 1024                 # 16 × 16 words, row-major
.text
    la   s0, m
    li   s1, N
    li   a0, 0
    li   t0, 0                # i
outer:
    li   t1, 0                # j
inner:
    li   t6, COLUMNS
    beqz t6, rows
    mul  t2, t1, s1           # column order: j*N + i (stride 64 bytes)
    add  t2, t2, t0
    j    access
rows:
    mul  t2, t0, s1           # row order: i*N + j (stride 4 bytes)
    add  t2, t2, t1
access:
    sh2add t2, t2, s0         # byte address of m[...]
    lw   t3, 0(t2)
    add  a0, a0, t3
    addi t1, t1, 1
    blt  t1, s1, inner
    addi t0, t0, 1
    blt  t0, s1, outer
    li   a7, 10
    ecall
`,
  },
  {
    id: "selftest",
    chapter: "13 · Testing",
    title: "Big self-test (47 checks)",
    blurb: "Exercises every instruction class, memory widths, branches, M corner cases, sorting, recursion and jalr; prints ok/FAIL per check.",
    source: selftest,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
