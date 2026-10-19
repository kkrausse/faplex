// Session clients kept by `watch` for the program reading it, so opening a session is a repaint
// instead of a fresh attach. That program owns the terminal and `watch` does not, so the bytes go
// over a Unix socket (owner-only), one connection per open: the program writes a JSON header line
// ({ key, cols, rows }), then the raw keys; it gets the session's output back, and the
// connection ends when the session is left (ctrl+], or ← at an empty prompt). Window size and
// "warm this one up" come as JSON lines on `watch`'s stdin. Only sessions `watch` lists can be
// opened, with the command it lists for them: nothing a connection sends is run.
//
// The client handling follows the dashboard's (main.tsx): a hidden shadow screen for the ←
// check, the harness's terminal modes undone on leaving and re-applied on opening, Claude's
// output held until a typed "." shows and is erased, and hidden clients one row short so
// opening is a real resize and the harness repaints.
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import type { Config } from "./config.ts";
import { on, type Machine } from "./machines.ts";
import { CLEAR, createModes, createShadow, isBackInput, isLeftInput, type Modes, type Shadow } from "./passthrough.ts";
import type { Harness } from "./session.ts";

export type Open = { cmd: string[]; cwd: string };

type Pane = {
  key: string;
  harness: Harness;
  open: Open;
  proc: Bun.Subprocess;
  shadow: Shadow;
  modes: Modes;
  /** The connection it is shown on, if any. */
  shown?: Socket;
  exited?: number;
  note?: string;
  tail: string;
  ready: boolean;
  held: Buffer[];
  cap?: Timer;
  buffered?: Uint8Array[];
  probe?: { step: "dot" | "erase"; base: string | undefined };
  /** Last time it was on screen; undefined while it has only been warmed. */
  shownAt?: number;
  startedAt: number;
};

const READY_CAP_MS = 3000;
const PROBE_ECHO_MS = 1000;
/** A warmed client nobody opened is closed sooner than one that was looked at. */
const WARM_UNUSED_MS = 2 * 60_000;
const ATTACHING = "\x1b[2mattaching…\x1b[0m\r";

const socketPath = () => {
  const dir = `${homedir()}/.local/state/faplex`;
  const path = `${dir}/watch-${process.pid}.sock`;
  // Unix socket paths are capped at ~104 bytes on macOS.
  if (path.length < 100) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path;
  }
  return `${tmpdir()}/faplex-watch-${process.pid}.sock`;
};

/** `lookup` gives a listed session's open command, undefined for one that isn't listed or can't be opened. */
export function createHeld(config: Config, machine: (id: string) => Machine, lookup: (key: string) => Open | undefined) {
  const panes = new Map<string, Pane>();
  let size = { cols: 80, rows: 24 };

  const fit = (p: Pane, rows: number) => {
    p.shadow.resize(size.cols, rows);
    if (p.exited === undefined) p.proc.terminal?.resize(size.cols, rows);
  };
  const send = (p: Pane, data: Uint8Array | string) => void (p.exited === undefined && p.proc.terminal?.write(data));

  function markReady(p: Pane) {
    if (p.ready) return;
    clearTimeout(p.cap);
    p.ready = true;
    if (p.held.length) p.probe = undefined;
    const buffered = p.buffered;
    p.buffered = undefined;
    if (p.shown) {
      if (buffered) p.shown.write(Buffer.concat(["\r\x1b[2K", ...buffered].map((d) => Buffer.from(d))));
      for (const d of p.held) send(p, d);
    }
    p.held = [];
  }

  // Claude turns on bracketed paste before its prompt is drawn, so it is probed: a "." typed has to
  // show on its input line and a backspace has to erase it before keys pass.
  function probe(p: Pane) {
    const step = p.probe;
    if (!step) {
      if (p.ready || !p.modes.on("2004")) return;
      p.probe = { step: "dot", base: p.shadow.claudeInput() };
      send(p, ".");
      clearTimeout(p.cap);
      p.cap = setTimeout(() => markReady(p), PROBE_ECHO_MS);
      return;
    }
    const line = p.shadow.claudeInput();
    if (step.step === "dot" && line !== undefined && line !== step.base && line.endsWith(".")) {
      step.step = "erase";
      send(p, "\x7f");
      if (p.ready) return;
      clearTimeout(p.cap);
      p.cap = setTimeout(() => markReady(p), PROBE_ECHO_MS);
    } else if (step.step === "erase" && line !== undefined && (step.base === undefined ? !line.endsWith(".") : line === step.base)) {
      p.probe = undefined;
      markReady(p);
    }
  }

  function spawn(key: string, open: Open, rows: number): Pane {
    const m = machine(key.slice(0, key.indexOf("/")));
    const harness = key.slice(key.indexOf("/") + 1, key.indexOf(":", key.indexOf("/"))) as Harness;
    const decoder = new TextDecoder();
    const p: Pane = {
      key, harness, open, proc: undefined!, shadow: createShadow(size.cols, rows), modes: createModes(), tail: "", ready: false, held: [],
      buffered: harness === "claude" ? [] : undefined, startedAt: Date.now(),
    };
    p.proc = Bun.spawn(on(m, open.cmd, { cwd: open.cwd, tty: true }), {
      cwd: !m.ssh && existsSync(open.cwd) ? open.cwd : homedir(),
      env: { ...process.env, COLORTERM: "truecolor" },
      terminal: {
        cols: size.cols,
        rows,
        data: (_t, d) => {
          if (p.buffered) p.buffered.push(d);
          else p.shown?.write(d);
          p.shadow.write(d);
          const text = decoder.decode(d, { stream: true });
          p.tail = (p.tail + text).slice(-2000);
          p.modes.track(text);
          if (p.probe || (!p.ready && p.buffered)) probe(p);
          if (!p.ready) {
            if (!p.buffered && p.modes.on("2004")) markReady(p);
            if (!p.ready) p.cap ??= setTimeout(() => markReady(p), READY_CAP_MS);
          }
        },
      },
    });
    void p.proc.exited.then((code) => {
      p.exited = code;
      markReady(p);
      if (code === 0) return p.shown ? leave(p) : drop(p);
      p.note = `${open.cmd.join(" ")}${m.ssh ? ` on ${m.id}` : ""} exited ${code}`;
      p.shown?.write(`${p.modes.undo()}\r\n\x1b[33m[faplex] ${p.note} · ctrl+] or ← to go back\x1b[0m\r\n`);
      p.modes.clear();
    });
    panes.set(key, p);
    return p;
  }

  function drop(p: Pane) {
    if (panes.get(p.key) === p) panes.delete(p.key);
    if (p.exited === undefined) p.proc.kill();
    p.shadow.destroy();
  }

  function leave(p: Pane) {
    const socket = p.shown;
    if (!socket) return;
    p.shown = undefined;
    p.shownAt = Date.now();
    p.held = [];
    socket.end(p.modes.undo());
    if (p.exited !== undefined) drop(p);
    else fit(p, Math.max(1, size.rows - 1));
  }

  function show(p: Pane, socket: Socket) {
    // One screen per session: an older connection still showing it is let go.
    if (p.shown && p.shown !== socket) leave(p);
    p.shown = socket;
    p.shownAt = Date.now();
    socket.write(CLEAR + p.modes.restore());
    if (p.exited === undefined) {
      fit(p, size.rows);
      if (p.buffered || !p.tail) socket.write(ATTACHING);
    } else socket.write(`${p.tail}\r\n\x1b[0m\x1b[33m[faplex] ${p.note} · ctrl+] or ← to go back\x1b[0m\r\n`);
  }

  function input(p: Pane, data: Buffer) {
    const text = data.toString("latin1");
    const empty = p.exited !== undefined || (!p.ready && p.held.length === 0) || (p.ready && p.shadow.atPromptStart());
    if (isBackInput(text) || (isLeftInput(text) && empty)) return leave(p);
    if (p.exited !== undefined) return;
    if (!p.ready) return void p.held.push(data);
    p.probe = undefined;
    send(p, data);
  }

  const path = socketPath();
  rmSync(path, { force: true });
  const server = createServer((socket) => {
    let pane: Pane | undefined;
    let header = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (pane) return input(pane, chunk);
      header = Buffer.concat([header, chunk]);
      const nl = header.indexOf(10);
      if (nl === -1) return;
      let h: { key?: string; cols?: number; rows?: number };
      try {
        h = JSON.parse(header.subarray(0, nl).toString());
      } catch {
        return void socket.destroy();
      }
      const open = h.key ? lookup(h.key) : undefined;
      if (!h.key || !open) return void socket.end(`faplex: ${h.key ?? "?"} is not a session this watch lists\r\n`);
      if (h.cols && h.rows) size = { cols: h.cols, rows: h.rows };
      const known = panes.get(h.key);
      // A client that died while hidden is replaced.
      if (known?.exited !== undefined) drop(known);
      pane = panes.get(h.key) ?? spawn(h.key, open, size.rows);
      show(pane, socket);
      const rest = header.subarray(nl + 1);
      if (rest.length) input(pane, rest);
    });
    // The reader went away without leaving (it quit, or crashed): the client stays, hidden.
    socket.on("close", () => {
      if (pane?.shown === socket) leave(pane);
    });
    socket.on("error", () => {});
  });
  server.listen(path, () => chmodSync(path, 0o600));
  process.on("exit", () => rmSync(path, { force: true }));

  // Hidden clients are closed after `closeHiddenAfterMinutes`, warmed ones nobody opened sooner.
  setInterval(() => {
    const now = Date.now();
    for (const p of [...panes.values()]) {
      if (p.shown) continue;
      if (p.shownAt === undefined ? now - p.startedAt > WARM_UNUSED_MS : now - p.shownAt > config.closeHiddenAfterMs) drop(p);
    }
  }, 30_000).unref?.();

  return {
    path,
    /** The reader's terminal size; a shown client follows it, hidden ones sit a row short. */
    resize(cols: number, rows: number) {
      size = { cols, rows };
      for (const p of panes.values()) fit(p, p.shown ? rows : Math.max(1, rows - 1));
    },
    /** Attach a client ahead of being opened, so opening is a repaint. */
    warm(key: string) {
      const open = lookup(key);
      if (open && !panes.has(key)) spawn(key, open, Math.max(1, size.rows - 1));
    },
    close() {
      server.close();
      for (const p of [...panes.values()]) drop(p);
      rmSync(path, { force: true });
    },
  };
}
