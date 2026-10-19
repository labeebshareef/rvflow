import { describe, expect, it } from "vitest";
import { assemble } from "./assembler";

describe("assembler", () => {
  it("expands li into one or two instructions", () => {
    const p = assemble("li a0, 42\nli a1, 0x12345678\nli a2, -1\nli a3, 0x800");
    expect(p.errors).toEqual([]);
    expect(p.text.map((t) => t.asm)).toEqual([
      "addi a0, zero, 42",
      "lui a1, 0x12345",
      "addi a1, a1, 1656",
      "addi a2, zero, -1",
      "lui a3, 0x1",
      "addi a3, a3, -2048",
    ]);
    expect(p.text[1].pseudo).toEqual({ source: "li a1, 0x12345678", part: 1, of: 2 });
  });

  it("resolves forward labels in li and la", () => {
    const p = assemble(".text\nla a0, msg\nli a1, later\nlater: nop\n.data\nmsg: .string \"hi\"");
    expect(p.errors).toEqual([]);
    expect(p.text.length).toBe(5);
    expect(p.symbols.get("msg")).toBe(0x10000);
    expect(p.data).toEqual([104, 105, 0]);
  });

  it("lays out data directives with alignment", () => {
    const p = assemble(".data\na: .byte 1, 2\n.align 2\nb: .word 0x11223344, a\nc: .half -1\nd: .zero 3");
    expect(p.errors).toEqual([]);
    expect(p.symbols.get("b")).toBe(0x10004);
    expect(p.data.slice(4, 12)).toEqual([0x44, 0x33, 0x22, 0x11, 0x00, 0x00, 0x01, 0x00]);
    expect(p.data.slice(12)).toEqual([0xff, 0xff, 0, 0, 0]);
  });

  it("reports friendly errors with line numbers", () => {
    const p = assemble("addi t0, t0, 5000\nadd t0, t1\nfoo t0\nbeq t0, t1, nowhere\nlw t0, 4(q9)");
    expect(p.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 5]);
    expect(p.errors[0].message).toMatch(/use li/);
    expect(p.errors[1].message).toMatch(/expected 3 operands/);
    expect(p.errors[2].message).toMatch(/unknown instruction/);
    expect(p.errors[3].message).toMatch(/unknown label/);
    expect(p.errors[4].message).toMatch(/not a register/);
  });

  it("supports %hi/%lo, .equ and character literals", () => {
    const p = assemble(".equ N, 10\nlui t0, %hi(0x12345FFF)\naddi t0, t0, %lo(0x12345FFF)\nli t1, N+2\nli t2, 'A'");
    expect(p.errors).toEqual([]);
    expect(p.text.map((t) => t.asm)).toEqual(["lui t0, 0x12346", "addi t0, t0, -1", "addi t1, zero, 12", "addi t2, zero, 65"]);
  });

  it("maps source lines to addresses and finds the entry point", () => {
    const p = assemble("j main\nhelper: ret\nmain:\n  call helper");
    expect(p.errors).toEqual([]);
    expect(p.entry).toBe(8);
    expect(p.lineToAddrs.get(4)).toEqual([8, 12]);
  });
});
