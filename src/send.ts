// `faplex send <key> <text>`: put a message into a session as if typed at its prompt, without a
// terminal. A busy session queues it and takes it after the current turn, like a message typed
// while it works.
//
// Claude has no command for this, so a `claude attach` runs in a PTY nobody sees: once its input
// line is drawn and empty, a typed "." has to show there and be erased (as in held.ts), then the
// text is pasted and Enter pressed. It counts as sent when the input line is empty again (taken)
// or Claude offers to send the queued message now. Anything else on screen (a permission menu, a
// question, a draft) fails instead of being typed into. Killing the client afterwards leaves the
// session running, queued message included. OpenCode takes it through its service's prompt
// request. Codex isn't reached yet.
import { homedir } from "node:os";
import { Effect } from "effect";
import type { Command } from "./cli.ts";
import { on, q, sh, type Machine } from "./machines.ts";
import { createModes, createShadow } from "./passthrough.ts";
import { parseKey } from "./session.ts";

const COLS = 120;
const ROWS = 40;
const EMPTY = "❯";
const QUEUED = /to send now/;

async function sendClaude(m: Machine, id: string, text: string): Promise<string | undefined> {
  const shadow = createShadow(COLS, ROWS);
  const modes = createModes();
  const decoder = new TextDecoder();
  let tail = "";
  let changedAt = Date.now();
  const proc = Bun.spawn(on(m, ["claude", "attach", id], { tty: true }), {
    cwd: homedir(),
    env: { ...process.env, COLORTERM: "truecolor" },
    terminal: {
      cols: COLS,
      rows: ROWS,
      data: (_t, d) => {
        shadow.write(d);
        const t = decoder.decode(d, { stream: true });
        tail = (tail + t).slice(-2000);
        modes.track(t);
        changedAt = Date.now();
      },
    },
  });
  let exited: number | undefined;
  void proc.exited.then((code) => (exited = code));
  const until = async (ok: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; !ok(); await Bun.sleep(50)) if (Date.now() > end || exited !== undefined) return ok();
    return true;
  };
  // Claude puts a no-break space after its ❯.
  const input = () => shadow.claudeInput()?.replaceAll("\u00a0", " ");
  const type = (s: string) => proc.terminal?.write(s);
  const lastWords = () => tail.replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").trim().split("\n").at(-1)?.trim() ?? "";
  // What this run typed and did not send is erased again before leaving: a Claude draft belongs to
  // the session, not the client, so it would wait at the prompt for whoever opens it next.
  let typed = false;
  const run = async (): Promise<string | undefined> => {
    if (!(await until(() => modes.on("2004") && input() !== undefined, 15_000)))
      return exited !== undefined ? `claude attach ${id} exited ${exited}: ${lastWords()}` : `claude attach ${id}: no input line after 15s`;
    // Let the first paint finish: a menu or a restored draft can land after the input line.
    await until(() => Date.now() - changedAt > 500, 3000);
    if (input() !== EMPTY) return `${id} is not at an empty prompt (a menu, a question or a draft is open): open it to answer`;
    typed = true;
    type(".");
    if (!(await until(() => input() === `${EMPTY} .`, 5000))) return `${id} did not echo at its prompt: open it to check`;
    type("\x7f");
    if (!(await until(() => input() === EMPTY, 3000))) return `${id}: could not clear the probe from its prompt`;
    type(`\x1b[200~${text}\x1b[201~`);
    if (!(await until(() => input() !== EMPTY, 3000))) return `${id}: the message did not show at its prompt`;
    type("\r");
    if (!(await until(() => input() === EMPTY || shadow.lines().some((l) => QUEUED.test(l)), 5000))) return `${id}: the message stayed at its prompt: open it to check`;
    typed = false;
    return undefined;
  };
  try {
    const error = await run();
    if (!error || !typed || exited !== undefined) return error;
    for (let i = 0; i < 3 && input() !== EMPTY; i++) {
      type("\x15");
      await until(() => input() === EMPTY, 1000);
    }
    return input() === EMPTY ? error : `${error} (and what it typed is still at the prompt)`;
  } finally {
    proc.kill();
    shadow.destroy();
  }
}

const sendOpencode = (m: Machine, id: string, text: string) =>
  Effect.runPromise(sh(m, `opencode api post ${q(`/api/session/${id}/prompt`)} --data ${q(JSON.stringify({ text }))}`, { timeout: 30_000 })).then(
    (out) => (out.code === 0 ? undefined : out.stderr.trim() || `opencode prompt exited ${out.code}`),
    (e) => (e instanceof Error ? e.message : String(e)),
  );

export async function send(machine: (id: string) => Machine, cmd: Extract<Command, { kind: "send" }>): Promise<number> {
  const k = parseKey(cmd.key)!;
  const text = (cmd.text ?? (await new Response(Bun.stdin.stream()).text())).trim();
  const error =
    !text ? "nothing to send"
    : k.harness === "codex" ? "send does not reach Codex sessions yet"
    : k.harness === "claude" ? await sendClaude(machine(k.machine), k.id, text)
    : await sendOpencode(machine(k.machine), k.id, text);
  if (error) {
    process.stderr.write(`faplex: ${error}\n`);
    return 1;
  }
  return 0;
}
