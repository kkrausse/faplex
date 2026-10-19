// `faplex new --background`: start a session without a terminal and exit once it is running, so
// another program can stay on its own screen. Claude's `--bg` launch and OpenCode's service
// request are the session; Codex takes the prompt from its CLI, which runs here in a PTY nobody
// sees until the session is listed and working, then is closed (the agent carries on in its daemon).
// Exit codes: 0 running (its key on stdout), 1 failed (why on stderr), 3 the folder's trust prompt
// needs answering on screen: run `new` without --background.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Command } from "./cli.ts";
import { dirKey, remember } from "./last-pick.ts";
import { on } from "./machines.ts";
import { hasStarted, sessionKey, type Session } from "./session.ts";
import { sourceKey, type DashStore } from "./store.ts";
import { addTags } from "./tags.ts";
import { defaultDir } from "./watch.ts";

const WAIT_MS = 30_000;
export const NEEDS_TRUST = 3;

export async function startInBackground(store: DashStore, cmd: Extract<Command, { kind: "new" }>): Promise<number> {
  const fail = (message: string) => {
    process.stderr.write(`faplex: ${message}\n`);
    return 1;
  };
  const until = async (ready: () => boolean) => {
    for (const end = Date.now() + WAIT_MS; !ready(); await Bun.sleep(100)) if (Date.now() > end) return false;
    return true;
  };
  const source = () => store.state.sources[sourceKey(cmd.machine, cmd.harness)];
  if (!source()) return fail(`${cmd.harness} is not offered by this config`);
  if (!(await until(() => source()!.loaded))) return fail(`${cmd.harness} on ${cmd.machine} did not report in`);
  const problem = source()!.problem;
  // A stopped daemon is started by the harness's own CLI.
  if (problem && problem.kind !== "stopped") return fail(`${cmd.harness} on ${cmd.machine}: ${problem.message}`);

  const m = store.machine(cmd.machine);
  const dir = cmd.dir ?? defaultDir(store, m.id);
  remember({ machine: m.id, harness: cmd.harness }, dirKey(m.id, !!m.ssh), dir);
  const known = new Set(store.rows(cmd.harness).filter((s) => s.machine === m.id).map((s) => s.key));
  let l;
  try {
    l = await store.launch(m.id, cmd.harness, dir, cmd.prompt);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if ("trust" in l) {
    process.stderr.write(`faplex: ${dir} needs its trust prompt answered\n`);
    return NEEDS_TRUST;
  }
  const claim = l.claim;
  const find = (): Session | undefined =>
    store.rows(cmd.harness).find((s) => s.machine === m.id && ("id" in claim ? s.id === claim.id : s.cwd === claim.firstNewIn && !known.has(s.key)));
  if ("id" in claim) addTags(sessionKey(m.id, cmd.harness, claim.id), cmd.tags);

  // Claude's `--bg` and OpenCode's service already run the session; Codex takes its prompt from its CLI.
  const client =
    cmd.harness !== "codex"
      ? undefined
      : Bun.spawn(on(m, l.cmd, { cwd: l.cwd, tty: true }), {
          cwd: !m.ssh && existsSync(l.cwd) ? l.cwd : homedir(),
          env: { ...process.env, COLORTERM: "truecolor" },
          terminal: { cols: 120, rows: 40, data: () => {} },
        });
  let exited: number | undefined;
  void client?.exited.then((code) => (exited = code));
  const running = () => {
    const s = find();
    return !!s && (!cmd.prompt || hasStarted(s));
  };
  const ok = await until(() => running() || exited !== undefined);
  client?.kill();
  const s = find();
  if (!ok || !s) return fail(exited !== undefined ? `${l.cmd.join(" ")} exited ${exited}` : `${cmd.harness} session not listed after ${WAIT_MS / 1000}s`);
  addTags(s.key, cmd.tags);
  process.stdout.write(`${s.key}\n`);
  return 0;
}
