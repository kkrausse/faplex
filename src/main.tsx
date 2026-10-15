import { existsSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { render, useRenderer } from "@opentui/solid";
import { Show, createEffect, createSignal } from "solid-js";
import { createDashStore, type DashStore, type Launch } from "./store.ts";
import { NewSession, type Pick } from "./new-session.tsx";
import { dirKey, loadRemembered, remember } from "./last-pick.ts";
import { SessionList } from "./list.tsx";
import { on } from "./machines.ts";
import { remoteDrops } from "./drop.ts";
import { CLEAR, createModes, createShadow, isBackInput, isLeftInput, type Modes, type Shadow } from "./passthrough.ts";
import { hasStarted, sessionKey, type Claim, type Session } from "./session.ts";
import { colors } from "./theme.ts";
import { register } from "./procs.ts";
import { hostArgs } from "./cli.ts";
import { loadConfig, type Config } from "./config.ts";

const hosts = hostArgs(process.argv.slice(2));
let config: Config;
try {
  config = loadConfig(hosts);
} catch (e) {
  console.error(`faplex: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
register();

const store = createDashStore(config);
store.start();

// A native CLI running in a PTY (over ssh for remote machines). While it is open the dashboard's
// renderer is suspended and the CLI owns the real terminal: output and keys pass straight through.
// It outlives the view: going back to the list hides it, reopening makes it repaint.
// A new session starts under a placeholder key; `claim` finds its real row once its source reports it.
// `fresh` marks an unused new chat: it is cached for reuse (the picker reopens on it) and hidden
// from the list until its source reports a prompt.
type Client = {
  session: Session;
  proc: Bun.Subprocess;
  /** Input for the CLI. With `uploadDrops`, a remote one gets dropped local files copied over on the way (drop.ts). */
  send: (data: Uint8Array) => void;
  /** Never drawn; answers whether the cursor is at an empty prompt. */
  shadow: Shadow;
  /** Terminal modes the CLI switched on, undone for the list and re-applied on reopening. */
  modes: Modes;
  exited?: number;
  /** Why it exited, when that wasn't a clean leave. */
  note?: string;
  claim?: { claim: Claim; known: ReadonlySet<string> };
  fresh?: Pick;
  /** Last time it was on screen. */
  shownAt: number;
  /** Tail of the output, to explain a failed ssh. */
  tail: string;
  /** False until the CLI takes keys; keys typed before then wait in `held`. */
  ready: boolean;
  held: Buffer[];
  cap?: Timer;
  /** Claude's output until it is ready, written out in one go then: the probe never shows. */
  buffered?: Uint8Array[];
  /** How far the probe got: "." typed, then erased. `base` is Claude's input line before it, if drawn yet. */
  probe?: { step: "dot" | "erase"; base: string | undefined };
};

// A newly attached CLI takes keys once it turns on bracketed paste. OpenCode and Codex do that first
// thing. Claude turns it on before its prompt is drawn, and ← there opens Claude's own agents view,
// so Claude is probed after: a "." typed has to show on its input line and a backspace has to
// erase it. Keys pass only once the dot is gone. A "." that doesn't show within PROBE_ECHO_MS (a
// permission menu) lets keys pass, but a late one is still erased until the first key goes in.
// READY_CAP_MS (from the first output) covers a CLI that never turns on bracketed paste.
const READY_CAP_MS = 3000;
const PROBE_ECHO_MS = 1000;
const ATTACHING = "\x1b[2mattaching…\x1b[0m\r";

const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

const matches = (c: NonNullable<Client["claim"]>, ref: Session, s: Session) =>
  s.machine === ref.machine &&
  s.harness === ref.harness &&
  ("id" in c.claim ? s.id === c.claim.id : s.cwd === c.claim.firstNewIn && !c.known.has(s.key));

// sshd caps sessions per connection (MaxSessions, default 10); every pane, stream and command on a
// host shares one connection.
const SSH_REFUSED = /administratively prohibited|open failed|session request failed|Session open refused/i;

// What a terminal shows on its tab. The leading glyph is the only "icon" a terminal tab has: it is
// how a harness marks its own tabs, and what a web terminal can key a favicon on.
const TITLE = "⧉ faplex";
// XTWINOPS title stack: the title the tab had before comes back on quit, where it is supported.
const PUSH_TITLE = "\x1b[22;0t";
const POP_TITLE = "\x1b]0;\x07\x1b[23;0t";

function App(props: { store: DashStore }) {
  const renderer = useRenderer();
  process.stdout.write(PUSH_TITLE);
  renderer.setTerminalTitle(TITLE);
  const clients = new Map<string, Client>();
  // equals:false so re-setting the same client after a claim refreshes it.
  const [view, setView] = createSignal<Client | undefined>(undefined, { equals: false });
  const [screen, setScreen] = createSignal<"list" | "new">("list");
  // Where the picker opens: the last machine × harness a new session was started on, in any dashboard.
  const [lastPick, setLastPick] = createSignal<Pick | undefined>(loadRemembered().pick);
  const [live, setLive] = createSignal<ReadonlySet<string>>(new Set());
  const [freshKeys, setFreshKeys] = createSignal<ReadonlySet<string>>(new Set());
  // Used new chats whose session hasn't been reported yet.
  const [pending, setPending] = createSignal<Session[]>([]);
  // Remount the list on return so it re-sorts with fresh status.
  const [mount, setMount] = createSignal({ n: 0, selected: undefined as string | undefined, flash: undefined as string | undefined, swallowEnter: false });

  const syncLive = () => {
    const alive = [...clients.values()].filter((c) => c.exited === undefined);
    setLive(new Set(alive.map((c) => c.session.key)));
    setFreshKeys(new Set(alive.filter((c) => c.fresh).map((c) => c.session.key)));
    // One that died before its session turned up keeps its row, so the failure can be opened and read.
    setPending([...clients.values()].filter((c) => c.claim && !c.fresh && c.exited !== 0).map((c) => c.session));
  };
  const cachedFresh = (p: Pick) =>
    [...clients.values()].find((c) => c.fresh?.machine === p.machine && c.fresh.harness === p.harness && c.exited === undefined);

  // Keys go to the CLI untouched, except the ones that leave: ctrl+] anywhere, and ← when the
  // cursor sits at an empty prompt.
  const onInput = (data: Buffer) => {
    const c = view();
    if (!c) return;
    const input = data.toString("latin1");
    // Still attaching with nothing typed: ← can only mean leave.
    const empty = c.exited !== undefined || (!c.ready && c.held.length === 0) || (c.ready && c.shadow.atPromptStart());
    if (isBackInput(input) || (isLeftInput(input) && empty)) return back();
    if (c.exited !== undefined) return;
    if (!c.ready) return void c.held.push(data);
    // A "." showing from here on could be the user's.
    c.probe = undefined;
    c.send(data);
  };
  const onResize = () => {
    const c = view();
    if (c?.exited === undefined) fit(c, size().rows);
  };
  function fit(c: Client | undefined, rows: number) {
    const { cols } = size();
    c?.shadow.resize(cols, rows);
    c?.proc.terminal?.resize(cols, rows);
  }

  // Hand the terminal to a client, or take it back for the list.
  function show(c: Client | undefined) {
    const now = Date.now();
    const prev = view();
    if (prev) {
      prev.shownAt = now;
      // Keys held while it was attaching were for that screen.
      prev.held = [];
      process.stdin.off("data", onInput);
      process.stdout.off("resize", onResize);
      process.stdout.write(prev.modes.undo());
      // Hidden clients sit one row short, so reopening is a real resize and the CLI repaints.
      if (prev.exited === undefined) fit(prev, Math.max(1, size().rows - 1));
      renderer.resume();
      // The harness put its own title on the tab.
      renderer.setTerminalTitle(TITLE);
    }
    setView(c);
    if (!c) return;
    c.shownAt = now;
    renderer.suspend();
    process.stdout.write(CLEAR + c.modes.restore());
    if (c.exited === undefined) {
      fit(c, size().rows);
      if (c.buffered || !c.tail) process.stdout.write(ATTACHING);
    } else process.stdout.write(`${c.tail}\r\n\x1b[0m\x1b[33m[faplex] ${c.note} · ctrl+] or ← to go back\x1b[0m\r\n`);
    process.stdin.setRawMode(true);
    process.stdin.on("data", onInput);
    process.stdin.resume();
    process.stdout.on("resize", onResize);
  }

  function back(flash?: string) {
    const c = view();
    // Whatever was just done in the session (a prompt sent, an answer given) shows on the list now.
    if (c) props.store.refresh(c.session.machine);
    // Always the list, a new chat included: whether its first prompt went in can't be told from
    // the keys (a paste or dictation delivers text and Enter as one chunk). An unused one stays
    // cached, and `n` reopens the picker on it.
    if (c?.fresh && c.exited === undefined) setLastPick(c.fresh);
    show(undefined);
    if (c?.exited !== undefined) drop(c);
    setMount({ n: mount().n + 1, selected: c?.session.key, flash, swallowEnter: false });
  }

  function drop(c: Client) {
    // A reattached session already has its next client under the same key.
    if (clients.get(c.session.key) === c) clients.delete(c.session.key);
    c.shadow.destroy();
    syncLive();
  }

  // Hidden clients are closed after `closeHiddenAfterMinutes`; the agents live on in their daemons
  // and reopening is cheap.
  setInterval(() => {
    const now = Date.now();
    for (const c of [...clients.values()]) {
      if (c === view() || now - c.shownAt < config.closeHiddenAfterMs) continue;
      if (c.exited === undefined) c.proc.kill();
      drop(c);
    }
  }, 60_000).unref?.();

  function markReady(c: Client) {
    if (c.ready) return;
    clearTimeout(c.cap);
    c.ready = true;
    // From here a "." on the input line could be the user's.
    if (c.held.length) c.probe = undefined;
    const buffered = c.buffered;
    c.buffered = undefined;
    if (view() === c) {
      // Over the "attaching…" line, at the top left where the CLI's output starts.
      if (buffered && !quitting) process.stdout.write(Buffer.concat(["\r\x1b[2K", ...buffered].map((d) => Buffer.from(d))));
      for (const d of c.held) c.send(d);
    }
    c.held = [];
  }

  function probe(c: Client) {
    const write = (k: string) => void (c.exited === undefined && c.proc.terminal?.write(k));
    const p = c.probe;
    if (!p) {
      if (c.ready || !c.modes.on("2004")) return;
      c.probe = { step: "dot", base: c.shadow.claudeInput() };
      write(".");
      clearTimeout(c.cap);
      c.cap = setTimeout(() => markReady(c), PROBE_ECHO_MS);
      return;
    }
    const line = c.shadow.claudeInput();
    if (p.step === "dot" && line !== undefined && line !== p.base && line.endsWith(".")) {
      p.step = "erase";
      write("\x7f");
      if (c.ready) return;
      // The backspace is in; only its echo is outstanding.
      clearTimeout(c.cap);
      c.cap = setTimeout(() => markReady(c), PROBE_ECHO_MS);
    } else if (p.step === "erase" && line !== undefined && (p.base === undefined ? !line.endsWith(".") : line === p.base)) {
      c.probe = undefined;
      markReady(c);
    }
  }

  function spawn(s: Session, rows = size().rows): Client {
    const m = props.store.machine(s.machine);
    const { cols } = size();
    const c: Client = { session: s, proc: undefined!, send: undefined!, shadow: createShadow(cols, rows), modes: createModes(), shownAt: Date.now(), tail: "", ready: false, held: [], buffered: s.harness === "claude" ? [] : undefined };
    const decoder = new TextDecoder();
    // Store values are proxies; Bun.spawn needs a plain array.
    const cmd = on(m, [...s.open!.cmd], { cwd: s.open!.cwd, tty: true });
    const proc = Bun.spawn(cmd, {
      cwd: !m.ssh && existsSync(s.open!.cwd) ? s.open!.cwd : homedir(),
      env: { ...process.env, COLORTERM: "truecolor" },
      terminal: {
        cols,
        rows,
        data: (_t, d) => {
          if (c.buffered) c.buffered.push(d);
          else if (view() === c && !quitting) process.stdout.write(d);
          c.shadow.write(d);
          const text = decoder.decode(d, { stream: true });
          c.tail = (c.tail + text).slice(-2000);
          c.modes.track(text);
          if (c.probe || (!c.ready && c.buffered)) probe(c);
          if (!c.ready) {
            if (!c.buffered && c.modes.on("2004")) markReady(c);
            if (!c.ready) c.cap ??= setTimeout(() => markReady(c), READY_CAP_MS);
          }
        },
      },
    });
    c.proc = proc;
    // A paste held for a copy may come out after the CLI is gone.
    const write = (d: Uint8Array) => void (c.exited === undefined && proc.terminal?.write(d));
    c.send = m.ssh && config.uploadDrops ? remoteDrops(m, write) : write;
    proc.exited.then((code) => {
      c.exited = code;
      markReady(c);
      syncLive();
      // A clean exit is the CLI's own "leave"; an error stays on screen until ctrl+] or ←.
      if (code === 0) {
        if (view() === c) back();
        else drop(c);
      } else {
        const refused = m.ssh && SSH_REFUSED.test(c.tail);
        c.note = refused
          ? `${m.ssh} refused another ssh session on the shared connection (sshd MaxSessions, default 10) · close some panes or raise MaxSessions`
          : `${s.open!.cmd.join(" ")}${m.ssh ? ` on ${m.id}` : ""} exited ${code}`;
        // The CLI may have died with its modes still on.
        if (view() === c) process.stdout.write(`${c.modes.undo()}\r\n\x1b[33m[faplex] ${c.note} · ctrl+] or ← to go back\x1b[0m\r\n`);
        c.modes.clear();
        if (c.claim) {
          c.session = { ...c.session, status: "failed", detail: c.note };
          syncLive();
        }
      }
    });
    clients.set(s.key, c);
    syncLive();
    return c;
  }

  function open(s: Session) {
    props.store.reopened(s);
    show(clients.get(s.key) ?? spawn(s));
  }

  // For a pane that may have gone stale: closes the session's client and attaches a new one. The
  // agent itself lives in its daemon and isn't touched.
  function reattach(s: Session) {
    const c = clients.get(s.key);
    if (c) {
      drop(c);
      if (c.exited === undefined) c.proc.kill();
    }
    open(s);
  }

  // A session started on a prompt needs nobody watching, so it opens no pane: its client runs
  // hidden and its row shows on the list. Without a prompt the new chat opens, as an unused one.
  async function pick(p: Pick, dir: string, prompt?: string) {
    setLastPick(p);
    remember(p, dirKey(p.machine, !!props.store.machine(p.machine).ssh), dir);
    const cached = prompt ? undefined : cachedFresh(p);
    if (cached) {
      setScreen("list");
      show(cached);
      return;
    }
    const known = new Set(props.store.rows(p.harness).filter((s) => s.machine === p.machine).map((s) => s.key));
    const l = await props.store.launch(p.machine, p.harness, dir, prompt);
    const shown = !prompt || "trust" in l;
    // Started hidden, it sits one row short like any hidden client, so first opening it repaints.
    const c = spawn(placeholder(p, l, prompt), shown ? size().rows : Math.max(1, size().rows - 1));
    if (shown) c.fresh = p;
    if ("trust" in l) awaitTrust(c, p, dir, known, prompt);
    else c.claim = { claim: l.claim, known };
    syncLive();
    setScreen("list");
    // The trust prompt has to be answered on screen.
    if (shown) return show(c);
    awaitStart(c);
    props.store.refresh(p.machine);
    // An Enter pressed again while it started would open the new row.
    setMount({ n: mount().n + 1, selected: c.session.key, flash: undefined, swallowEnter: true });
  }
  // A hidden client whose session never turns up is waiting on something only its pane shows (a
  // trust or login prompt, a failed start), so its row asks to be opened.
  function awaitStart(c: Client) {
    setTimeout(() => {
      if (!c.claim || c.exited !== undefined || view() === c || clients.get(c.session.key) !== c) return;
      c.session = { ...c.session, status: "needs", detail: "not started yet · open it to see why" };
      syncLive();
    }, 12_000);
  }
  const placeholder = (p: Pick, l: Launch, prompt?: string): Session => ({
    machine: p.machine, harness: p.harness, key: sessionKey(p.machine, p.harness, `new-${Date.now()}`), id: "", title: prompt ?? `new ${p.harness} session`,
    cwd: l.cwd, status: "working", detail: "", model: "", updatedAt: Date.now(), archived: false, stoppable: false, open: { cmd: l.cmd, cwd: l.cwd },
  });

  // `c` shows the harness's trust prompt for an untrusted folder. Once the prompt is accepted the
  // launch goes through, and the pane is swapped for the session it was meant to open. Only tried
  // while the pane is on screen: that is when the prompt can be answered.
  function awaitTrust(c: Client, p: Pick, dir: string, known: ReadonlySet<string>, prompt?: string) {
    let trying = false;
    const timer = setInterval(async () => {
      if (c.exited !== undefined || clients.get(c.session.key) !== c) return clearInterval(timer);
      if (trying || view() !== c) return;
      trying = true;
      try {
        const l = await props.store.launch(p.machine, p.harness, dir, prompt);
        if ("trust" in l || c.exited !== undefined || clients.get(c.session.key) !== c) return;
        clearInterval(timer);
        const next = spawn(placeholder(p, l, prompt));
        next.claim = { claim: l.claim, known };
        if (!prompt) next.fresh = p;
        const shown = view() === c;
        drop(c);
        if (shown) show(next);
        c.proc.kill();
      } catch {
        // Unreachable for a moment, or still refused for another reason: the next tick tries again.
      } finally {
        trying = false;
      }
    }, 1000);
  }

  createEffect(() => {
    const all = props.store.rows();
    for (const c of [...clients.values()]) {
      // Claiming an ID doesn't mean a prompt was sent. This applies to every harness.
      const reported = all.find((s) => s.key === c.session.key);
      if (c.fresh && !c.claim && reported && hasStarted(reported)) {
        c.fresh = undefined;
        syncLive();
      }
      const cl = c.claim;
      const real = cl && all.find((s) => matches(cl, c.session, s));
      if (!real) continue;
      clients.delete(c.session.key);
      c.session = real;
      c.claim = undefined;
      if (hasStarted(real)) c.fresh = undefined;
      clients.set(real.key, c);
      syncLive();
    }
  });

  // Quitting from inside a session: the renderer is suspended and only knows its own modes, so
  // the ones the CLI switched on (alternate screen, kitty keys, focus and mouse reports, bracketed
  // paste) would stay on in the shell, which then prints every report as text. Also run on
  // "exit", for an end that never reaches `quit`. Written synchronously: the process is ending.
  const handBack = () => {
    const c = view();
    if (!c) return;
    const undo = c.modes.undo();
    c.modes.clear();
    try {
      writeSync(1, undo);
    } catch {
      // The terminal is gone.
    }
  };
  process.on("exit", handBack);

  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    // From here a dying CLI's last output is dropped too, so it can't switch anything back on.
    quitting = true;
    // Whatever below hangs or throws (a terminal that is gone, a stuck ssh), the process still ends.
    setTimeout(() => process.exit(0), 3000);
    try {
      process.stdin.off("data", onInput);
      handBack();
      // Clients only; every agent lives on in its own daemon.
      for (const c of clients.values()) c.proc.kill();
      renderer.destroy();
      // Left raw by an open session: a suspended renderer doesn't put the tty back.
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(POP_TITLE);
      await props.store.stop();
    } finally {
      process.exit(0);
    }
  };
  // A dashboard whose terminal went away (tab closed, harness killed) would otherwise keep polling
  // every host with nobody watching.
  // SIGINT and SIGQUIT too: the renderer handles them itself only while it isn't suspended.
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT", "SIGQUIT"] as const) process.on(sig, () => void quit());
  process.stdin.on("end", () => void quit());
  process.stdin.on("error", () => void quit());
  process.stdout.on("error", () => void quit());
  // The signal doesn't always arrive; being handed to init is the other sign the terminal is gone.
  const parent = process.ppid;
  setInterval(() => {
    if (parent !== 1 && process.ppid === 1) void quit();
  }, 10_000).unref?.();

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={colors.bg}>
      <Show when={!view() && screen() === "new"}>
        <box flexGrow={1} minHeight={0}>
          <NewSession
            store={props.store}
            initial={lastPick()}
            active={() => !view() && screen() === "new"}
            cached={(p) => !!cachedFresh(p)}
            onCancel={() => setScreen("list")}
            onPick={pick}
          />
        </box>
      </Show>
      <box visible={!view() && screen() === "list"} flexGrow={1} minHeight={0}>
        <Show when={mount()} keyed>
          {(m) => (
            <SessionList
              store={props.store}
              initialSelected={m.selected}
              flash={m.flash}
              swallowEnter={m.swallowEnter}
              active={() => !view() && screen() === "list"}
              onNew={() => setScreen("new")}
              live={live}
              hidden={freshKeys}
              extra={pending}
              onOpen={open}
              onReattach={reattach}
              onQuit={() => void quit()}
            />
          )}
        </Show>
      </box>
    </box>
  );
}

await render(() => <App store={store} />, { exitOnCtrlC: false, targetFps: 30 });
