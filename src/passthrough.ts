import { OptimizedBuffer, resolveRenderLib } from "@opentui/core";

// An open session owns the real terminal: its output is written straight through, so nothing the
// harness emits (OSC 8 links, OSC 52, images) is lost to an emulator in between. What the
// dashboard still needs to know is kept here: a hidden screen for the "← on an empty prompt" check,
// and the terminal modes the harness switched on, so they can be undone and re-applied around the list.

/** Home, clear the screen and its scrollback: the reopened harness repaints its own history. */
export const CLEAR = "\x1b[H\x1b[2J\x1b[3J";

const isCtrlRightBracket = /\x1d|\x1b\[93;5u|\x1b\[27;5;93~/;
// Unmodified ←: legacy, application cursor keys, and the kitty form (press or repeat).
const isPlainLeft = /^(?:\x1b\[D|\x1bOD|\x1b\[1;1(?::[12])?D)$/;

export const isBackInput = (input: string) => isCtrlRightBracket.test(input);
export const isLeftInput = (input: string) => isPlainLeft.test(input);

// ← leaves the session when the cursor sits right after an input prompt with nothing typed before it.
// A false positive is cheap: the client stays alive and reopening restores it as it was.
const PROMPT_START = /^\s*[❯›>┃│]?\s*$/;

export interface Shadow {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  atPromptStart(): boolean;
  destroy(): void;
}

/** A terminal emulator that is never drawn. Only the cursor and the text on its line are read. */
export function createShadow(cols: number, rows: number): Shadow {
  const lib = resolveRenderLib();
  let handle: ReturnType<typeof lib.createEmbeddedTerminal> | null = lib.createEmbeddedTerminal({ cols, rows, maxScrollback: 0 });
  return {
    write(data) {
      if (handle === null) return;
      lib.embeddedTerminalWrite(handle, data);
      // The real terminal answers the harness's queries; these replies would be duplicates.
      lib.embeddedTerminalDrainResponses(handle);
    },
    resize(c, r) {
      if (handle === null || (c === cols && r === rows)) return;
      cols = c;
      rows = r;
      lib.embeddedTerminalResize(handle, cols, rows);
      lib.embeddedTerminalDrainResponses(handle);
    },
    atPromptStart() {
      if (handle === null) return false;
      // The cursor is only known for a composed frame. Composing draws just the cells that changed
      // since the last one, so invalidate first: a fresh buffer would otherwise come back blank,
      // and a blank line reads as an empty prompt.
      lib.embeddedTerminalInvalidate(handle);
      const buffer = OptimizedBuffer.create(cols, rows, "unicode");
      try {
        lib.embeddedTerminalCompose(handle, buffer.ptr, 0, 0);
        const cursor = lib.embeddedTerminalCursor(handle);
        if (!cursor.hasValue || !cursor.visible) return false;
        const line = new TextDecoder().decode(buffer.getRealCharBytes(true)).split("\n")[cursor.y] ?? "";
        return PROMPT_START.test([...line].slice(0, cursor.x).join(""));
      } finally {
        buffer.destroy();
      }
    },
    destroy() {
      if (handle === null) return;
      lib.destroyEmbeddedTerminal(handle);
      handle = null;
    },
  };
}

export interface Modes {
  /** Record the mode changes in a chunk of harness output. */
  track(chunk: string): void;
  /** Sequences that put the terminal back in the modes the harness left it in. */
  restore(): string;
  /** Sequences that undo those modes, for handing the terminal back to the dashboard. */
  undo(): string;
  clear(): void;
}

// Private modes that are on in a fresh terminal: autowrap and the visible cursor.
const DEFAULT_ON = new Set(["7", "25"]);
// Synchronized output brackets a single frame; it is never a state to carry over.
const TRANSIENT = new Set(["2026"]);
const MODE_CHANGE = /\x1b\[(?:\?([\d;]+)([hl])|>(\d*)u|<(\d*)u|=(\d+)(?:;\d)?u|>4(?:;(\d))?m)/g;
const UNFINISHED = /\x1b(?:\[[?<>=]?[\d;]*)?$/;

export function createModes(): Modes {
  const priv = new Map<string, boolean>();
  // Kitty keyboard flags the harness pushed, innermost last.
  let kitty: string[] = [];
  let modifyOtherKeys = "0";
  let carry = "";
  return {
    track(chunk) {
      const text = carry + chunk;
      for (const [, modes, set, push, pop, replace, mok] of text.matchAll(MODE_CHANGE)) {
        if (modes !== undefined) for (const m of modes.split(";")) if (!TRANSIENT.has(m)) priv.set(m, set === "h");
        if (push !== undefined) kitty.push(push || "0");
        if (pop !== undefined) kitty = kitty.slice(0, Math.max(0, kitty.length - Number(pop || 1)));
        if (replace !== undefined) kitty = [...kitty.slice(0, -1), replace];
        if (modes === undefined && push === undefined && pop === undefined && replace === undefined) modifyOtherKeys = mok ?? "0";
      }
      carry = text.match(UNFINISHED)?.[0] ?? "";
    },
    restore() {
      let out = "";
      for (const [m, on] of priv) if (on !== DEFAULT_ON.has(m)) out += `\x1b[?${m}${on ? "h" : "l"}`;
      for (const flags of kitty) out += `\x1b[>${flags}u`;
      if (modifyOtherKeys !== "0") out += `\x1b[>4;${modifyOtherKeys}m`;
      return out;
    },
    undo() {
      let out = "\x1b[0m\x1b[r\x1b[0 q";
      if (modifyOtherKeys !== "0") out += "\x1b[>4;0m";
      if (kitty.length) out += `\x1b[<${kitty.length}u`;
      for (const [m, on] of priv) if (on !== DEFAULT_ON.has(m)) out += `\x1b[?${m}${on ? "l" : "h"}`;
      return out;
    },
    clear() {
      priv.clear();
      kitty = [];
      modifyOtherKeys = "0";
      carry = "";
    },
  };
}
