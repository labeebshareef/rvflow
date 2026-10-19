import { describe, expect, it } from "vitest";
import { assemble } from "@/asm/assembler";
import { Cpu } from "./cpu";
import { find } from "./trace";

function run(src: string, maxSteps = 10_000): Cpu {
  const p = assemble(src);
  if (p.errors.length) throw new Error(p.errors.map((e) => `${e.line}: ${e.message}`).join("\n"));
  const cpu = new Cpu();
  cpu.reset(p.entry);
  for (const t of p.text) cpu.mem.write(t.addr, 4, t.word);
  cpu.mem.load(p.dataBase, p.data);
  cpu.textEnd = p.textEnd;
  for (let i = 0; i < maxSteps && !cpu.halted; i++) cpu.step();
  return cpu;
}

const reg = (cpu: Cpu, n: number) => cpu.regs[n];

describe("RV32I semantics", () => {
  it("runs the blueprint's addi example and traces it", () => {
    const p = assemble("addi t1, t1, 10");
    const cpu = new Cpu();
    cpu.reset();
    cpu.regs[6] = 32;
    cpu.mem.write(0, 4, p.text[0].word);
    cpu.textEnd = p.textEnd;
    const rec = cpu.step();
    expect(find(rec.events, "FETCH")?.word).toBe(0x00a30313);
    expect(find(rec.events, "ALU")).toMatchObject({ op: "ADD", a: 32, b: 10, out: 42 });
    expect(find(rec.events, "REG_WRITE")).toMatchObject({ reg: 6, old: 32, value: 42 });
    expect(find(rec.events, "PC")).toMatchObject({ old: 0, next: 4 });
  });

  it("ignores writes to x0", () => {
    const cpu = run("addi x0, x0, 5\nadd t0, x0, x0");
    expect(reg(cpu, 0)).toBe(0);
    expect(reg(cpu, 5)).toBe(0);
  });

  it("computes arithmetic, logic, shifts and compares", () => {
    const cpu = run(`
      li t0, -8
      li t1, 3
      add  s0, t0, t1    # -5
      sub  s1, t0, t1    # -11
      sll  s2, t1, t1    # 24
      srl  s3, t0, t1    # 0x1FFFFFFF
      sra  s4, t0, t1    # -1
      slt  s5, t0, t1    # 1
      sltu s6, t0, t1    # 0
      xori s7, t1, -1    # -4
      sltiu s8, t1, -1   # 1 (imm sign-extends then compares unsigned)
      srai s9, t0, 1     # -4
    `);
    expect(reg(cpu, 8)).toBe(-5);
    expect(reg(cpu, 9)).toBe(-11);
    expect(reg(cpu, 18)).toBe(24);
    expect(reg(cpu, 19)).toBe(0x1fffffff);
    expect(reg(cpu, 20)).toBe(-1);
    expect(reg(cpu, 21)).toBe(1);
    expect(reg(cpu, 22)).toBe(0);
    expect(reg(cpu, 23)).toBe(-4);
    expect(reg(cpu, 24)).toBe(1);
    expect(reg(cpu, 25)).toBe(-4);
  });

  it("loads and stores little-endian with sign/zero extension", () => {
    const cpu = run(`
      la t0, buf
      li t1, 0x12345678
      sw t1, 0(t0)
      lb  a0, 0(t0)    # 0x78
      lbu a1, 3(t0)    # 0x12
      lh  a2, 2(t0)    # 0x1234
      li t2, -1
      sb t2, 4(t0)
      lb a3, 4(t0)     # -1
      lbu a4, 4(t0)    # 255
      sh t2, 6(t0)
      lhu a5, 6(t0)    # 65535
      .data
      buf: .zero 8
    `);
    expect(cpu.mem.readBytes(0x10000, 4)).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect([reg(cpu, 10), reg(cpu, 11), reg(cpu, 12), reg(cpu, 13), reg(cpu, 14), reg(cpu, 15)]).toEqual([
      0x78, 0x12, 0x1234, -1, 255, 65535,
    ]);
  });

  it("branches, loops and function calls", () => {
    const cpu = run(`
      li a0, 0
      li t0, 1
      li t1, 11
    loop:
      add a0, a0, t0
      addi t0, t0, 1
      blt t0, t1, loop     # a0 = 55
      call double
      li a7, 10
      ecall
    double:
      add a0, a0, a0
      ret
    `);
    expect(reg(cpu, 10)).toBe(110);
    expect(cpu.halted?.reason).toBe("exit");
  });

  it("covers every branch condition, signed and unsigned", () => {
    const cpu = run(`
      li t0, -1
      li t1, 1
      li a0, 0
      blt t0, t1, 1f
      j fail
    1: bltu t1, t0, 2f
      j fail
    2: bge t1, t0, 3f
      j fail
    3: bgeu t0, t1, 4f
      j fail
    4: bne t0, t1, 5f
      j fail
    5: beq t0, t0, ok
    fail: li a0, 99
      ebreak
    ok: li a0, 1
    `.replace(/(\d)f\b/g, "L$1").replace(/^\s*(\d):/gm, "L$1:"));
    expect(reg(cpu, 10)).toBe(1);
  });

  it("lui / auipc / jalr", () => {
    const cpu = run(`
      lui t0, 0xABCDE
      auipc t1, 0x1       # pc = 4 → 0x1004
      la t2, target
      jalr ra, 0(t2)
      li a0, 7
    target:
      li a1, 9
    `);
    expect(reg(cpu, 5) >>> 0).toBe(0xabcde000);
    expect(reg(cpu, 6)).toBe(0x1004);
    expect(reg(cpu, 10)).toBe(0);
    expect(reg(cpu, 11)).toBe(9);
    expect(reg(cpu, 1)).toBe(20); // la is two instructions, so jalr sits at 16
  });
});

describe("M extension", () => {
  it("multiplies and divides, including the never-trap corner cases", () => {
    const cpu = run(`
      li t0, -7
      li t1, 2
      mul a0, t0, t1      # -14
      div a1, t0, t1      # -3 (round toward zero)
      rem a2, t0, t1      # -1
      divu a3, t0, x0     # -1 (div by zero)
      rem a4, t0, x0      # -7
      li t2, 0x80000000
      li t3, -1
      div a5, t2, t3      # overflow → 0x80000000
      rem a6, t2, t3      # 0
      mulh s0, t2, t2     # 0x40000000
      mulhu s1, t3, t3    # 0xFFFFFFFE
      mulhsu s2, t3, t3   # -1
    `);
    expect([10, 11, 12, 13, 14, 15, 16].map((r) => reg(cpu, r))).toEqual([-14, -3, -1, -1, -7, -0x80000000, 0]);
    expect(reg(cpu, 8)).toBe(0x40000000);
    expect(reg(cpu, 9) >>> 0).toBe(0xfffffffe);
    expect(reg(cpu, 18)).toBe(-1);
  });
});

describe("environment, traps and undo", () => {
  it("prints via ecall", () => {
    const cpu = run(`
      la a0, msg
      li a7, 4
      ecall
      li a0, 42
      li a7, 1
      ecall
      li a0, 10
      li a7, 11
      ecall
      .data
      msg: .string "answer="
    `);
    expect(cpu.output).toBe("answer=42\n");
    expect(cpu.halted?.reason).toBe("end");
  });

  it("traps on misaligned loads and illegal instructions", () => {
    expect(run("li t0, 2\nlw a0, 0(t0)").halted).toMatchObject({ reason: "trap" });
    const cpu = run("j far\n.data\nfar: .word 0");
    expect(cpu.halted?.reason).toBe("trap");
  });

  it("undo restores registers, memory, PC and output exactly", () => {
    const p = assemble("li t0, 5\nsw t0, 0(sp)\nli a0, 3\nli a7, 1\necall\naddi t0, t0, 1");
    const cpu = new Cpu();
    cpu.reset();
    for (const t of p.text) cpu.mem.write(t.addr, 4, t.word);
    cpu.textEnd = p.textEnd;
    const before = { regs: cpu.regs.slice(), mem: cpu.mem.readBytes(cpu.regs[2], 4) };
    const recs = [];
    while (!cpu.halted) recs.push(cpu.step());
    expect(cpu.output).toBe("3");
    for (const r of recs.reverse()) cpu.undo(r);
    expect(cpu.regs).toEqual(before.regs);
    expect(cpu.mem.readBytes(cpu.regs[2], 4)).toEqual(before.mem);
    expect(cpu.pc).toBe(0);
    expect(cpu.output).toBe("");
    expect(cpu.instret).toBe(0);
  });
});
