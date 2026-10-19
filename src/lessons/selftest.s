# ===================================================================
#  rvflow self-test: a big program that exercises the whole simulator
# -------------------------------------------------------------------
#  Every check prints "ok" or "FAIL" to the Console tab, and the
#  summary at the end gives the totals. Exit code = number of failures.
#
#  Covers: ALU ops, immediates and shifts, lui/auipc/li, byte, halfword
#  and word loads and stores (little-endian), all six branches,
#  the M extension (including division corner cases), loops over
#  arrays, bubble sort, recursion with stack frames, strings, a
#  jump table through jalr, and writes to x0.
#
#  Tip: press E to run to the end, or set a breakpoint on a section.
# ===================================================================

.data
title:    .string "rvflow self-test\n"
s_test:   .string "test "
s_ok:     .string " ok\n"
s_fail:   .string " FAIL  got "
s_want:   .string " want "
s_nl:     .string "\n"
s_sum1:   .string "passed: "
s_sum2:   .string "  failed: "
s_hello:  .string "Hello, RISC-V!"
s_len:    .string "strlen = "
          .align 2
numbers:  .word 3, 1, 4, 1, 5, 9, 2, 6, 5, 3      # 10 words, sum = 39
unsorted: .word 42, -7, 19, 0, 1000, -300, 8, 8   # 8 words, sorted in place
bytes:    .byte 0x80, 0x7F, 0xFF, 0x01
          .align 2
scratch:  .zero 16
jumptab:  .word op_add, op_sub, op_mul           # function pointers

.text
main:
    li   s10, 0                 # passes
    li   s11, 0                 # failures
    li   s9, 1                  # test number

    la   a0, title
    li   a7, 4
    ecall

# ---------------- 1. ALU register-register ----------------
    li   t0, 100
    li   t1, -25
    add  a0, t0, t1
    li   a1, 75
    call check                  # 1: add

    li   t0, 100
    li   t1, -25
    sub  a0, t0, t1
    li   a1, 125
    call check                  # 2: sub

    li   t0, 0xF0F0
    li   t1, 0x0FF0
    and  a0, t0, t1
    li   a1, 0x00F0
    call check                  # 3: and

    li   t0, 0xF0F0
    li   t1, 0x0FF0
    or   a0, t0, t1
    li   a1, 0xFFF0
    call check                  # 4: or

    li   t0, 0xF0F0
    li   t1, 0x0FF0
    xor  a0, t0, t1
    li   a1, 0xFF00
    call check                  # 5: xor

    li   t0, -1
    li   t1, 1
    slt  a0, t0, t1             # signed: -1 < 1
    li   a1, 1
    call check                  # 6: slt

    li   t0, -1
    li   t1, 1
    sltu a0, t0, t1             # unsigned: 0xFFFFFFFF < 1 is false
    li   a1, 0
    call check                  # 7: sltu

# ---------------- 2. immediates and shifts ----------------
    li   t0, 5
    addi a0, t0, -2048          # most negative 12-bit immediate
    li   a1, -2043
    call check                  # 8: addi

    li   t0, 0x55
    xori a0, t0, -1             # same as not
    li   a1, -0x56
    call check                  # 9: xori -1

    li   t0, 1
    slli a0, t0, 31
    li   a1, 0x80000000
    call check                  # 10: slli

    li   t0, 0x80000000
    srli a0, t0, 4              # logical: zeros shift in
    li   a1, 0x08000000
    call check                  # 11: srli

    li   t0, 0x80000000
    srai a0, t0, 4              # arithmetic: sign bit copies in
    li   a1, 0xF8000000
    call check                  # 12: srai

    li   t0, 3
    li   t1, 37                 # only rs2[4:0] = 5 is used
    sll  a0, t0, t1
    li   a1, 96
    call check                  # 13: sll uses low 5 bits

    li   t0, 7
    sltiu a0, t0, -1            # -1 sign-extends to 0xFFFFFFFF
    li   a1, 1
    call check                  # 14: sltiu

# ---------------- 3. upper immediates ----------------
    lui  a0, 0xDEADB
    li   a1, 0xDEADB000
    call check                  # 15: lui

    li   a0, 0x12345678         # lui + addi
    lui  a1, 0x12345
    addi a1, a1, 0x678
    call check                  # 16: li expansion

    li   a0, 0x00000FFF         # needs lui 0x1 + addi -1
    li   a1, 4095
    call check                  # 17: li with carry

here:
    auipc a0, 0                 # a0 = address of this instruction
    la    a1, here
    call  check                 # 18: auipc

# ---------------- 4. memory ----------------
    la   s0, scratch
    li   t0, 0x12345678
    sw   t0, 0(s0)
    lbu  a0, 0(s0)              # little-endian: lowest byte first
    li   a1, 0x78
    call check                  # 19: sw/lbu byte order

    lbu  a0, 3(s0)
    li   a1, 0x12
    call check                  # 20: high byte

    lhu  a0, 2(s0)
    li   a1, 0x1234
    call check                  # 21: lhu

    la   s1, bytes
    lb   a0, 0(s1)              # 0x80 sign-extends
    li   a1, -128
    call check                  # 22: lb negative

    lbu  a0, 0(s1)
    li   a1, 128
    call check                  # 23: lbu

    lw   a0, 0(s1)              # 01 FF 7F 80 → 0x01FF7F80
    li   a1, 0x01FF7F80
    call check                  # 24: lw over bytes

    li   t0, -2
    sh   t0, 4(s0)
    lh   a0, 4(s0)
    li   a1, -2
    call check                  # 25: sh/lh

    li   t0, 0xAB
    sb   t0, 8(s0)
    sb   t0, 9(s0)
    lhu  a0, 8(s0)
    li   a1, 0xABAB
    call check                  # 26: sb twice + lhu

# ---------------- 5. branches ----------------
    li   s2, 0                  # bit mask of branches that went the right way
    li   t0, -5
    li   t1, 3
    beq  t0, t0, b1
    j    b1x
b1: ori  s2, s2, 1
b1x:
    bne  t0, t1, b2
    j    b2x
b2: ori  s2, s2, 2
b2x:
    blt  t0, t1, b3             # signed: -5 < 3
    j    b3x
b3: ori  s2, s2, 4
b3x:
    bge  t1, t0, b4
    j    b4x
b4: ori  s2, s2, 8
b4x:
    bltu t1, t0, b5             # unsigned: 3 < 0xFFFFFFFB
    j    b5x
b5: ori  s2, s2, 16
b5x:
    bgeu t0, t1, b6
    j    b6x
b6: ori  s2, s2, 32
b6x:
    blt  t1, t0, bad            # must NOT be taken
    ori  s2, s2, 64
bad:
    mv   a0, s2
    li   a1, 127
    call check                  # 27: all branches

# ---------------- 6. M extension ----------------
    li   t0, -6
    li   t1, 7
    mul  a0, t0, t1
    li   a1, -42
    call check                  # 28: mul

    li   t0, 0x10000
    li   t1, 0x10000
    mulhu a0, t0, t1            # 2^32 → high word = 1
    li   a1, 1
    call check                  # 29: mulhu

    li   t0, -1
    li   t1, -1
    mulh a0, t0, t1             # (-1)(-1) = 1 → high word 0
    li   a1, 0
    call check                  # 30: mulh

    li   t0, -1
    li   t1, 2
    mulhsu a0, t0, t1           # -1 × 2 = -2 → high word -1
    li   a1, -1
    call check                  # 31: mulhsu

    li   t0, -17
    li   t1, 5
    div  a0, t0, t1             # rounds toward zero
    li   a1, -3
    call check                  # 32: div

    li   t0, -17
    li   t1, 5
    rem  a0, t0, t1             # sign follows the dividend
    li   a1, -2
    call check                  # 33: rem

    li   t0, 99
    divu a0, t0, zero           # divide by zero → all ones
    li   a1, -1
    call check                  # 34: divu by zero

    li   t0, 99
    remu a0, t0, zero           # remainder by zero → dividend
    li   a1, 99
    call check                  # 35: remu by zero

    li   t0, 0x80000000
    li   t1, -1
    div  a0, t0, t1             # overflow: result is INT_MIN, no trap
    li   a1, 0x80000000
    call check                  # 36: div overflow

# ---------------- 7. loop: sum an array ----------------
    la   t0, numbers
    li   t1, 10                 # count
    li   a0, 0
sum_loop:
    lw   t2, 0(t0)
    add  a0, a0, t2
    addi t0, t0, 4
    addi t1, t1, -1
    bnez t1, sum_loop
    li   a1, 39
    call check                  # 37: array sum

# ---------------- 8. bubble sort ----------------
    la   a0, unsorted
    li   a1, 8
    call bubble_sort
    la   s0, unsorted
    lw   a0, 0(s0)
    li   a1, -300
    call check                  # 38: smallest first
    lw   a0, 28(s0)
    li   a1, 1000
    call check                  # 39: largest last
    # every neighbour pair must be in order
    la   s0, unsorted
    li   s1, 7
    li   s2, 1                  # assume sorted
sorted_loop:
    lw   t0, 0(s0)
    lw   t1, 4(s0)
    ble  t0, t1, pair_ok
    li   s2, 0
pair_ok:
    addi s0, s0, 4
    addi s1, s1, -1
    bnez s1, sorted_loop
    mv   a0, s2
    li   a1, 1
    call check                  # 40: fully sorted

# ---------------- 9. recursion ----------------
    li   a0, 10
    call fib                    # naive recursive fib(10)
    li   a1, 55
    call check                  # 41: fib(10)

    li   a0, 6
    call fact
    li   a1, 720
    call check                  # 42: 6!

    li   s0, 0x0003FFF0         # sp must be back where it started
    mv   a0, sp
    mv   a1, s0
    call check                  # 43: stack balanced

# ---------------- 10. strings ----------------
    la   a0, s_hello
    call strlen
    mv   s0, a0
    li   a1, 14
    call check                  # 44: strlen
    la   a0, s_len
    li   a7, 4
    ecall
    mv   a0, s0
    li   a7, 1
    ecall
    la   a0, s_nl
    li   a7, 4
    ecall

# ---------------- 11. jump table via jalr ----------------
    la   s0, jumptab
    lw   t0, 8(s0)              # op_mul
    li   a0, 6
    li   a1, 7
    jalr ra, 0(t0)
    li   a1, 42
    call check                  # 45: indirect call

    lw   t0, 4(s0)              # op_sub
    li   a0, 10
    li   a1, 4
    jalr t0
    li   a1, 6
    call check                  # 46: jalr rs form

# ---------------- 12. x0 stays zero ----------------
    li   t0, 1234
    add  zero, t0, t0
    addi x0, x0, 99
    mv   a0, zero
    li   a1, 0
    call check                  # 47: x0 hardwired

# ---------------- summary ----------------
    la   a0, s_sum1
    li   a7, 4
    ecall
    mv   a0, s10
    li   a7, 1
    ecall
    la   a0, s_sum2
    li   a7, 4
    ecall
    mv   a0, s11
    li   a7, 1
    ecall
    la   a0, s_nl
    li   a7, 4
    ecall
    mv   a0, s11                # exit code = failures
    li   a7, 93
    ecall

# ===================================================================
#  check(a0 = actual, a1 = expected): prints the result, bumps counters
#  Uses s9 (test number), s10 (passes), s11 (failures). Clobbers a/t regs.
# ===================================================================
check:
    addi sp, sp, -16
    sw   ra, 12(sp)
    sw   a0, 8(sp)
    sw   a1, 4(sp)
    la   a0, s_test
    li   a7, 4
    ecall
    mv   a0, s9
    li   a7, 1
    ecall
    lw   t0, 8(sp)
    lw   t1, 4(sp)
    bne  t0, t1, check_fail
    addi s10, s10, 1
    la   a0, s_ok
    li   a7, 4
    ecall
    j    check_done
check_fail:
    addi s11, s11, 1
    la   a0, s_fail
    li   a7, 4
    ecall
    lw   a0, 8(sp)
    li   a7, 34                 # print hex
    ecall
    la   a0, s_want
    li   a7, 4
    ecall
    lw   a0, 4(sp)
    li   a7, 34
    ecall
    la   a0, s_nl
    li   a7, 4
    ecall
check_done:
    addi s9, s9, 1
    lw   ra, 12(sp)
    addi sp, sp, 16
    ret

# bubble_sort(a0 = array, a1 = n): signed ascending, in place
bubble_sort:
    addi t0, a1, -1             # passes
outer:
    blez t0, sort_done
    mv   t1, a0                 # pointer
    mv   t2, t0                 # comparisons this pass
inner:
    lw   t3, 0(t1)
    lw   t4, 4(t1)
    ble  t3, t4, no_swap
    sw   t4, 0(t1)
    sw   t3, 4(t1)
no_swap:
    addi t1, t1, 4
    addi t2, t2, -1
    bnez t2, inner
    addi t0, t0, -1
    j    outer
sort_done:
    ret

# fib(a0 = n) → a0, naive recursion (lots of calls and returns)
fib:
    li   t0, 2
    blt  a0, t0, fib_base
    addi sp, sp, -16
    sw   ra, 12(sp)
    sw   s0, 8(sp)
    sw   s1, 4(sp)
    mv   s0, a0
    addi a0, a0, -1
    call fib
    mv   s1, a0                 # fib(n-1)
    addi a0, s0, -2
    call fib
    add  a0, a0, s1
    lw   s1, 4(sp)
    lw   s0, 8(sp)
    lw   ra, 12(sp)
    addi sp, sp, 16
fib_base:
    ret

# fact(a0 = n) → a0
fact:
    addi sp, sp, -16
    sw   ra, 12(sp)
    sw   s0, 8(sp)
    mv   s0, a0
    li   t0, 1
    ble  a0, t0, fact_base
    addi a0, a0, -1
    call fact
    mul  a0, a0, s0
    j    fact_out
fact_base:
    li   a0, 1
fact_out:
    lw   s0, 8(sp)
    lw   ra, 12(sp)
    addi sp, sp, 16
    ret

# strlen(a0 = string) → a0
strlen:
    mv   t0, a0
strlen_loop:
    lbu  t1, 0(t0)
    beqz t1, strlen_done
    addi t0, t0, 1
    j    strlen_loop
strlen_done:
    sub  a0, t0, a0
    ret

# jump-table targets: a0 = a0 op a1
op_add:
    add  a0, a0, a1
    ret
op_sub:
    sub  a0, a0, a1
    ret
op_mul:
    mul  a0, a0, a1
    ret
