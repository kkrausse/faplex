// bun run test:e2e   ← in an open session, against the real harnesses on the rig.
//   At an empty prompt ← leaves for the list; at the start of a later line of a prompt it belongs
//   to the harness. Both are decided from what the harness draws (src/passthrough.ts), so a harness
//   release can break them: CLAUDE_VERSION, CODEX_VERSION and OPENCODE_VERSION (a version or
//   `latest`) rebuild the rig with other versions than the pinned ones.
//   Brings the rig up and takes it down (KEEP_RIG=1 leaves it up). Needs docker and termctrl.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

const here = import.meta.dir;
const s = "faplex-e2e-left";
const env = { ...process.env, TERMCTRL_RUNTIME_DIR: "/tmp/tc-faplex-e2e-left" };

const run = (...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
};
const compose = (...args: string[]) => run("docker", "compose", "-f", `${here}/compose.yaml`, ...args);
const screen = () => run("termctrl", "show", s).out;
const see = (text: string, ms = 30_000) => {
  if (!run("termctrl", "wait", s, text, "--timeout", String(ms)).ok) throw new Error(`never showed "${text}":\n${screen()}`);
};
const settle = (ms = 1200) => Bun.sleep(ms);
const key = async (...keys: string[]) => {
  for (const k of keys) {
    run("termctrl", "send", s, k);
    await settle(k.startsWith("text:") || k === "backspace" ? 300 : 1200);
  }
};
// The list's column header; no harness screen has it, Claude's own agents view included.
const onList = () => /session\s+status/.test(screen());
const backOnList = async () => {
  for (let i = 0; i < 20 && !onList(); i++) await settle(250);
  return onList();
};

beforeAll(async () => {
  run("mkdir", "-p", "-m", "700", env.TERMCTRL_RUNTIME_DIR);
  compose("down", "-v");
  if (!compose("up", "-d", "--build", "--wait").ok) throw new Error("the rig did not come up (e2e/logs.sh)");
}, 900_000);

afterAll(() => {
  if (process.env.KEEP_RIG !== "1") compose("down", "-v");
}, 120_000);

// A new dashboard per test: the selection starts on the first row (pi's OpenCode session).
beforeEach(() => {
  run("termctrl", "stop", s);
  run("termctrl", "start", s, "--host", "opentui", "--cols", "110", "--rows", "26", "--", `${here}/faplex.sh`);
  see("Migrate cron jobs to systemd timers");
  see("Clean up stale build artifacts");
  see("Bump lodash to 4.17.21");
}, 120_000);
afterEach(() => void run("termctrl", "stop", s));

/** With the session open at an empty prompt: ← leaves, and ← at the start of line 2 does not. */
const leftBehaves = async (reopen: () => Promise<void>, newline: string[], typed: RegExp) => {
  await key("left");
  expect(await backOnList()).toBe(true);

  await reopen();
  await key("text:abc", ...newline, "left");
  await settle();
  expect(onList()).toBe(false);
  expect(screen()).toMatch(typed);
  // Claude Code's own agents view, which an unhandled ← at an empty prompt opens.
  expect(screen()).not.toContain("awaiting input");

  await key(...Array(6).fill("backspace"), "left");
  expect(await backOnList()).toBe(true);
};

test("Claude Code", async () => {
  const open = async () => { await key("right"); see("for agents"); await settle(); };
  await key("down", "down");
  await open();
  await leftBehaves(open, ["text:\\", "enter"], /❯\sabc/);
}, 120_000);

test("OpenCode", async () => {
  const open = async () => { await key("right"); see("migrate the cron jobs to systemd timers"); await settle(2500); };
  await open();
  await leftBehaves(open, ["ctrl-j"], /┃\s+abc/);
}, 120_000);

test("Codex", async () => {
  // A new chat: the rig seeds no Codex session. The unused chat is kept, and `n` goes back to it.
  const open = async () => { await key("text:n"); see("New session"); await key("enter"); see("OpenAI Codex"); await settle(2500); };
  await key("text:n");
  see("New session");
  await key("right", "right", "enter");
  see("Ask Codex");
  await settle(2500);
  await leftBehaves(open, ["ctrl-j"], /›\sabc/);
}, 120_000);
