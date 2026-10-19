/** Thrown inside Cpu.step() for synchronous exceptions; the core turns it into a trap. */
export class Trap {
  constructor(public cause: number, public tval: number, public message: string) {}
}
