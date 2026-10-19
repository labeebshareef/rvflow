import { useEffect, useRef } from "react";
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration, EditorView, GutterMarker, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { BY_MNEMONIC } from "@/isa/instructions";
import { parseFRegister, parseRegister, parseVRegister } from "@/isa/registers";
import { C_DEFS } from "@/isa/rvc";
import { PSEUDO_LIST } from "@/asm/assembler";
import { entryAt, focusAddr, useSim } from "@/store/sim";

const MNEMONICS = new Set([...BY_MNEMONIC.keys(), ...PSEUDO_LIST, ...C_DEFS.map((d) => d.mnemonic)]);
const isRegister = (w: string) => parseRegister(w) !== undefined || parseFRegister(w) !== undefined || parseVRegister(w) !== undefined;

/** Minimal RISC-V assembly tokenizer for highlighting. */
const riscv = StreamLanguage.define<{ start: boolean }>({
  startState: () => ({ start: true }),
  token(stream, state) {
    if (stream.sol()) state.start = true;
    if (stream.eatSpace()) return null;
    if (stream.match("#") || stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/) || stream.match(/^'(?:[^'\\]|\\.)'/)) return "string";
    if (stream.match(/^[A-Za-z_.$][\w.$]*:/)) return "labelName";
    if (stream.match(/^\.[A-Za-z_]\w*/)) return "meta";
    if (stream.match(/^%(hi|lo|pcrel_hi|pcrel_lo)\b/)) return "macroName";
    if (stream.match(/^-?(0x[0-9a-fA-F_]+|0b[01_]+|\d+)\b/)) return "number";
    const w = stream.match(/^[A-Za-z_.$][\w.$]*/) as RegExpMatchArray | null;
    if (w) {
      const word = w[0].toLowerCase();
      if (state.start && (MNEMONICS.has(word) || MNEMONICS.has(word.replace(/\.(aqrl|aq|rl)$/, "")))) {
        state.start = false;
        return "keyword";
      }
      state.start = false;
      if (isRegister(word) || word === "v0.t") return "variableName";
      return "name";
    }
    stream.next();
    return null;
  },
  tokenTable: { labelName: t.labelName, macroName: t.macroName, name: t.name },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--color-f-opcode)", fontWeight: "600" },
  { tag: t.variableName, color: "var(--color-f-rd)" },
  { tag: t.number, color: "var(--color-f-imm)" },
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.string, color: "var(--color-f-rs1)" },
  { tag: t.labelName, color: "var(--color-f-funct7)", fontWeight: "600" },
  { tag: t.meta, color: "var(--color-f-rs2)" },
  { tag: t.macroName, color: "var(--color-f-funct3)" },
  { tag: t.name, color: "var(--color-f-funct7)" },
]);

// Line decorations for the current instruction and assembler errors.
const setLines = StateEffect.define<{ current: number | null; errors: number[] }>();
const currentLine = Decoration.line({ class: "cm-rv-current" });
const errorLine = Decoration.line({ class: "cm-rv-error" });

const lineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setLines)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const lines = new Map<number, Decoration>();
      for (const l of e.value.errors) lines.set(l, errorLine);
      if (e.value.current) lines.set(e.value.current, currentLine);
      for (const [l, d] of [...lines].sort((a, b2) => a[0] - b2[0])) {
        if (l >= 1 && l <= tr.state.doc.lines) {
          const line = tr.state.doc.line(l);
          b.add(line.from, line.from, d);
        }
      }
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Breakpoint gutter.
const setBreakpoints = StateEffect.define<Set<number>>();
const bpState = StateField.define<Set<number>>({
  create: () => new Set(),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setBreakpoints)) return e.value;
    return v;
  },
});

class BpMarker extends GutterMarker {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-rv-bp";
    s.textContent = "●";
    s.setAttribute("aria-label", "breakpoint");
    return s;
  }
}
const bpMarker = new BpMarker();

function breakpointGutter(onToggle: (line: number) => void): Extension {
  return [
    bpState,
    gutter({
      class: "cm-rv-bp-gutter",
      lineMarker(view, line) {
        const n = view.state.doc.lineAt(line.from).number;
        return view.state.field(bpState).has(n) ? bpMarker : null;
      },
      lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setBreakpoints))),
      initialSpacer: () => bpMarker,
      domEventHandlers: {
        mousedown(view, line) {
          onToggle(view.state.doc.lineAt(line.from).number);
          return true;
        },
      },
    }),
  ];
}

export function Editor() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    const st = useSim.getState();
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: st.source,
        extensions: [
          lineNumbers(),
          breakpointGutter((l) => useSim.getState().toggleBreakpoint(l)),
          history(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          riscv,
          syntaxHighlighting(highlight),
          lineField,
          keymap.of([
            { key: "Mod-Enter", run: () => (useSim.getState().assembleAndLoad(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            // Ignore the echo of a document replaced from the store (e.g. loading a lesson).
            if (text !== useSim.getState().source) useSim.getState().setSource(text);
          }),
          EditorView.contentAttributes.of({ "aria-label": "RISC-V assembly source" }),
        ],
      }),
    });
    view.current = v;

    const sync = () => {
      const s = useSim.getState();
      const cur = s.program ? entryAt(focusAddr(s))?.line ?? null : null;
      v.dispatch({ effects: [setLines.of({ current: cur, errors: s.errors.map((e) => e.line) }), setBreakpoints.of(s.breakpoints)] });
    };
    sync();
    let last = "";
    const unsub = useSim.subscribe((s) => {
      // Replace the document when an example is loaded from outside the editor.
      if (s.source !== v.state.doc.toString()) {
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: s.source } });
      }
      const key = `${s.version}:${s.segIndex}:${s.segT >= 1}:${s.errors.length}:${s.breakpoints.size}:${s.program ? 1 : 0}`;
      if (key !== last) {
        last = key;
        sync();
      }
    });
    return () => {
      unsub();
      v.destroy();
    };
  }, []);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
