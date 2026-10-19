#!/usr/bin/env bash
# Builds the official riscv-tests (BSD-3-Clause) for RV32 with clang + lld and
# stores the ELF files in tests/riscv-tests/. The ELFs are committed, so the
# test suite runs without a RISC-V toolchain. Re-run to refresh them.
#
#   scripts/build-riscv-tests.sh [path-to-riscv-tests-checkout]
set -euo pipefail
SRC="${1:-}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/tests/riscv-tests"
if [[ -z "$SRC" ]]; then
  SRC="$(mktemp -d)/riscv-tests"
  git clone -q --depth 1 https://github.com/riscv-software-src/riscv-tests.git "$SRC"
  git -C "$SRC" submodule update -q --init --depth 1 env
fi
mkdir -p "$OUT"
cp "$SRC/LICENSE" "$OUT/LICENSE"
echo "riscv-tests $(git -C "$SRC" rev-parse HEAD), env $(git -C "$SRC/env" rev-parse HEAD)" > "$OUT/VERSION"

build() { # suite march tests...
  local suite=$1 march=$2; shift 2
  for t in "$@"; do
    local tmp
    tmp="$(mktemp --suffix=.s)"
    if clang --target=riscv32-unknown-elf -march="$march" -E -x assembler-with-cpp \
         -I"$SRC/env/p" -I"$SRC/isa/macros/scalar" "$SRC/isa/$suite/$t.S" 2>/dev/null \
         | node "$(dirname "$0")/fix-riscv-test-asm.mjs" > "$tmp" \
       && clang --target=riscv32-unknown-elf -march="$march" -mabi=ilp32 -mno-relax -static -nostdlib -fuse-ld=lld \
         -T"$SRC/env/p/link.ld" "$tmp" -o "$OUT/$suite-p-$t.elf" 2>"$tmp.err"; then :; else
      echo "not built: $suite-p-$t ($(grep -m1 error "$tmp.err" | sed 's/^[^:]*:[0-9]*:[0-9]*: //'))" | tee -a "$OUT/VERSION"
    fi
    rm -f "$tmp" "$tmp.err"
  done
}

G=rv32imafd_zicsr_zifencei
build rv32ui "$G" simple add addi and andi auipc beq bge bgeu blt bltu bne fence_i jal jalr lb lbu lh lhu lw ld_st lui \
  ma_data or ori sb sh sw st_ld sll slli slt slti sltiu sltu sra srai srl srli sub xor xori
build rv32um "$G" div divu mul mulh mulhsu mulhu rem remu
build rv32ua "$G" amoadd_w amoand_w amomax_w amomaxu_w amomin_w amominu_w amoor_w amoxor_w amoswap_w lrsc
build rv32uc rv32imafdc_zicsr_zifencei rvc
build rv32uf "$G" fadd fdiv fclass fcmp fcvt fcvt_w fmadd fmin ldst move recoding
build rv32ud "$G" fadd fdiv fclass fcmp fcvt fcvt_w fmadd fmin ldst recoding
build rv32mi "$G" breakpoint csr mcsr illegal ma_fetch ma_addr scall sbreak shamt lw-misaligned lh-misaligned sh-misaligned \
  sw-misaligned zicntr instret_overflow pmpaddr
build rv32si "$G" csr dirty ma_fetch scall sbreak wfi
build rv32uzba "${G}_zba" sh1add sh2add sh3add
build rv32uzbb "${G}_zbb" andn clz cpop ctz max maxu min minu orc_b orn rev8 rol ror rori sext_b sext_h xnor zext_h
build rv32uzbc "${G}_zbc" clmul clmulh clmulr
build rv32uzbs "${G}_zbs" bclr bclri bext bexti binv binvi bset bseti
ls "$OUT"/*.elf | wc -l | xargs echo "built ELF files:"
