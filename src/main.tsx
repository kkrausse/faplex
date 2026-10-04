import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { render, useRenderer } from "@opentui/solid";
import { Show, createEffect, createSignal } from "solid-js";
import { createDashStore, type DashStore, type Launch } from "./store.ts";
import { NewSession, type Pick } from "./new-session.tsx";
import { SessionList } from "./list.tsx";
import { on } from "./machines.ts";
import { CLEAR, createModes, createShadow, isBackInput, isLeftInput, type Modes, type Shadow } from "./passthrough.ts";
import { hasStarted, sessionKey, type Claim, type Session } from "./session.ts";
import { colors } from "./theme.ts";
import { command, register } from "./procs.ts";

if (command(process.argv.slice(2))) process.exit(0);
register();

const store = createDashStore();
store.start();

// Hidden clients are closed after this long; the agents live on in their daemons and reopening is cheap.
const REAP_MS = 15 * 60 * 1000;

// A native CLI running in a PTY (over ssh for remote machines). While it is open the dashboard's
// renderer is suspended and the CLI owns the real terminal: output and keys pass straight through.
// It outlives the view: going back to the list hides it, reopening makes it repaint.
// A new session starts under a placeholder key; `claim` finds its real row once its source reports it.
// `fresh` marks an unused new chat: it is cached for reuse (the picker reopens on it) and hidden
// from the list until its source reports a prompt.
type Client = {
  session: Session;
  proc: Bun.Subprocess;
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
};

const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

const matches = (c: NonNullable<Client["claim"]>, ref: Session, s: Session) =>
  s.machine === ref.machine &&
  s.harness === ref.harness &&
  ("id" in c.claim ? s.id === c.claim.id : s.cwd === c.claim.firstNewIn && !c.known.has(s.key));

// sshd caps sessions per connection (MaxSessions, default 10); every pane, stream and command on a
// host shares one connection.
const SSH_REFUSED = /administratively prohibited|open failed|session request failed|Session open refused/i;

function App(props: { store: DashStore }) {
  const renderer = useRenderer();
  const clients = new Map<string, Client>();
  // equals:false so re-setting the same client after a claim refreshes it.
  const [view, setView] = createSignal<Client | undefined>(undefined, { equals: false });
  const [screen, setScreen] = createSignal<"list" | "new">("list");
  const [lastPick, setLastPick] = createSignal<Pick>();
  const [live, setLive] = createSignal<ReadonlySet<string>>(new Set());
  const [freshKeys, setFreshKeys] = createSignal<ReadonlySet<string>>(new Set());
  // Used new chats whose session hasn't been reported yet.
  const [pending, setPending] = createSignal<Session[]>([]);
  // Remount the list on return so it re-sorts with fresh status.
  const [mount, setMount] = createSignal({ n: 0, selected: undefined as string | undefined, flash: undefined as string | undefined });

  const syncLive = () => {
    const alive = [...clients.values()].filter((c) => c.exited === undefined);
    setLive(new Set(alive.map((c) => c.session.key)));
    setFreshKeys(new Set(alive.filter((c) => c.fresh).map((c) => c.session.key)));
    setPending(alive.filter((c) => c.claim && !c.fresh).map((c) => c.session));
  };
  const cachedFresh = (p: Pick) =>
    [...clients.values()].find((c) => c.fresh?.machine === p.machine && c.fresh.harness === p.harness && c.exited === undefined);

  // Keys go to the CLI untouched, except the ones that leave: ctrl+] anywhere, and ← when the
  // cursor sits at an empty prompt.
  const onInput = (data: Buffer) => {
    const c = view();
    if (!c) return;
    const input = data.toString("latin1");
    const left = isLeftInput(input) && (c.exited !== undefined || c.shadow.atPromptStart());
    if (isBackInput(input) || left) return back();
    if (c.exited !== undefined) return;
    c.proc.terminal?.write(data);
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
      process.stdin.off("data", onInput);
      process.stdout.off("resize", onResize);
      process.stdout.write(prev.modes.undo());
      // Hidden clients sit one row short, so reopening is a real resize and the CLI repaints.
      if (prev.exited === undefined) fit(prev, Math.max(1, size().rows - 1));
      renderer.resume();
    }
    setView(c);
    if (!c) return;
    c.shownAt = now;
    renderer.suspend();
    process.stdout.write(CLEAR + c.modes.restore());
    if (c.exited === undefined) fit(c, size().rows);
    else process.stdout.write(`${c.tail}\r\n\x1b[0m\x1b[33m[faplex] ${c.note} · ctrl+] or ← to go back\x1b[0m\r\n`);
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
    setMount({ n: mount().n + 1, selected: c?.session.key, flash });
  }

  function drop(c: Client) {
    clients.delete(c.session.key);
    c.shadow.destroy();
    syncLive();
  }

  // Close clients that haven't been on screen for REAP_MS.
  setInterval(() => {
    const now = Date.now();
    for (const c of [...clients.values()]) {
      if (c === view() || now - c.shownAt < REAP_MS) continue;
      if (c.exited === undefined) c.proc.kill();
      drop(c);
    }
  }, 60_000).unref?.();

  function spawn(s: Session): Client {
    const m = props.store.machine(s.machine);
    const { cols, rows } = size();
    const c: Client = { session: s, proc: undefined!, shadow: createShadow(cols, rows), modes: createModes(), shownAt: Date.now(), tail: "" };
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
          if (view() === c) process.stdout.write(d);
          c.shadow.write(d);
          const text = decoder.decode(d, { stream: true });
          c.tail = (c.tail + text).slice(-2000);
          c.modes.track(text);
        },
      },
    });
    c.proc = proc;
    proc.exited.then((code) => {
      c.exited = code;
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

  async function pick(p: Pick, dir: string) {
    const cached = cachedFresh(p);
    if (cached) {
      setScreen("list");
      show(cached);
      return;
    }
    const known = new Set(props.store.rows(p.harness).filter((s) => s.machine === p.machine).map((s) => s.key));
    const l = await props.store.launch(p.machine, p.harness, dir);
    const c = spawn(placeholder(p, l));
    c.fresh = p;
    if ("trust" in l) awaitTrust(c, p, dir, known);
    else c.claim = { claim: l.claim, known };
    syncLive();
    setScreen("list");
    show(c);
  }
  const placeholder = (p: Pick, l: Launch): Session => ({
    machine: p.machine, harness: p.harness, key: sessionKey(p.machine, p.harness, `new-${Date.now()}`), id: "", title: `new ${p.harness} session`,
    cwd: l.cwd, status: "working", detail: "", model: "", updatedAt: Date.now(), archived: false, stoppable: false, open: { cmd: l.cmd, cwd: l.cwd },
  });

  // `c` shows the harness's trust prompt for an untrusted folder. Once the prompt is accepted the
  // launch goes through, and the pane is swapped for the session it was meant to open. Only tried
  // while the pane is on screen: that is when the prompt can be answered.
  function awaitTrust(c: Client, p: Pick, dir: string, known: ReadonlySet<string>) {
    let trying = false;
    const timer = setInterval(async () => {
      if (c.exited !== undefined || clients.get(c.session.key) !== c) return clearInterval(timer);
      if (trying || view() !== c) return;
      trying = true;
      try {
        const l = await props.store.launch(p.machine, p.harness, dir);
        if ("trust" in l || c.exited !== undefined || clients.get(c.session.key) !== c) return;
        clearInterval(timer);
        const next = spawn(placeholder(p, l));
        next.claim = { claim: l.claim, known };
        next.fresh = p;
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

  let quitting = false;
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    // Whatever below hangs or throws (a terminal that is gone, a stuck ssh), the process still ends.
    setTimeout(() => process.exit(0), 3000);
    try {
      // Clients only; every agent lives on in its own daemon.
      for (const c of clients.values()) c.proc.kill();
      renderer.destroy();
      await props.store.stop();
    } finally {
      process.exit(0);
    }
  };
  // A dashboard whose terminal went away (tab closed, harness killed) would otherwise keep polling
  // every host with nobody watching.
  for (const sig of ["SIGHUP", "SIGTERM"] as const) process.on(sig, () => void quit());
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
              active={() => !view() && screen() === "list"}
              onNew={() => setScreen("new")}
              live={live}
              hidden={freshKeys}
              extra={pending}
              onOpen={open}
              onQuit={() => void quit()}
            />
          )}
        </Show>
      </box>
    </box>
  );
}

await render(() => <App store={store} />, { exitOnCtrlC: false, targetFps: 30 });
