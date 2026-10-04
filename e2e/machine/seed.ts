// Seeds one machine: starts real sessions in each harness's daemon with prompts the fake API maps
// to a scenario (e2e/fakeapi/scenarios.ts), and waits until each harness reports the state the
// scenario leads to. Run by start.sh once the daemons are up.
//   bun /e2e/seed.ts                                        the plan for this hostname
//   bun /e2e/seed.ts <harness> <dir> <expect> <prompt...>   one session, for poking at the rig by hand
import { mkdirSync, readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { CodexRpc } from "/home/dev/faplex/src/codex-rpc.ts";

type Harness = "claude" | "codex" | "opencode";
type Expect = "working" | "needs" | "done";
type Seed = { harness: Harness; dir: string; title: string; prompt: string; expect: Expect; /** OpenCode only: its create API takes a caller-chosen id, which keeps the list footer the same every run. */ id?: string };

const HOME = homedir();
const TIMEOUT_MS = 60_000;

// A sparse starting list, one session per machine: something working, something waiting on a
// permission question, something finished. The prompt decides which (e2e/fakeapi/scenarios.ts):
// "migrate the cron jobs" is held open, "stale build artifacts" asks to run a shell command,
// "lodash" is answered. `expect` is the state the seed waits for.
const PLAN: Record<string, Seed[]> = {
  laptop: [{ harness: "claude", dir: "~/src/shop-api", title: "Bump lodash to 4.17.21", prompt: "bump lodash to 4.17.21", expect: "done" }],
  devbox: [{ harness: "claude", dir: "~/src/shop-api", title: "Clean up stale build artifacts", prompt: "clean up the stale build artifacts", expect: "needs" }],
  pi: [{ harness: "opencode", dir: "~/src/site", title: "Migrate cron jobs to systemd timers", prompt: "migrate the cron jobs to systemd timers", expect: "working", id: "ses_migrate_cron_jobs" }],
};

const expand = (p: string) => (p.startsWith("~/") ? HOME + p.slice(1) : p);
const run = async (cmd: string[], cwd: string) => {
  const p = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};
/** Polls until `check` holds; a seed that never reaches its state fails the whole seed (and the container's health check). */
async function until(what: string, check: () => Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- Claude Code

/** `claude --bg` hands the session to Claude's daemon and returns its job id. */
async function seedClaude(s: Seed) {
  const r = await run(["claude", "--bg", "--name", s.title, s.prompt], expand(s.dir));
  const id = (r.out + r.err).replace(/\x1b\[[0-9;]*m/g, "").match(/backgrounded · (\w+)/)?.[1];
  if (!id) throw new Error(`claude --bg: ${(r.out + r.err).trim()}`);
  await until(`claude ${id} ${s.expect}`, async () => {
    const list = JSON.parse((await run(["claude", "agents", "--json", "--all"], HOME)).out) as { id?: string; status?: string; state?: string }[];
    const e = list.find((x) => x.id === id);
    return s.expect === "working" ? e?.status === "busy" : s.expect === "needs" ? e?.status === "waiting" : e?.status === "idle" && e.state === "done";
  });
  return id;
}

// ---------------------------------------------------------------- Codex

type Watch = { active: boolean; flags: string[]; completed: boolean };
const watches = new Map<string, Watch>();
const watch = (id: string) => watches.get(id) ?? (watches.set(id, { active: false, flags: [], completed: false }), watches.get(id)!);

/**
 * Codex threads live in the app-server daemon, so the seed speaks its JSON-RPC (with faplex's own
 * client) rather than running `codex exec`, which owns the thread in its own process and leaves it
 * "notLoaded" in the daemon. The thread stays loaded, with its status, after this client disconnects.
 */
async function seedCodex(s: Seed, rpc: CodexRpc) {
  // "untrusted" asks before any command that is not known to be read-only (config.toml no longer accepts it; the RPC does).
  const started = await rpc.request("thread/start", { cwd: expand(s.dir), approvalPolicy: "untrusted" });
  const threadId: string = started.thread.id;
  await rpc.request("thread/name/set", { threadId, name: s.title });
  await rpc.request("turn/start", { threadId, input: [{ type: "text", text: s.prompt }] });
  await until(`codex ${threadId} ${s.expect}`, async () => {
    const w = watch(threadId);
    return s.expect === "working" ? w.active : s.expect === "needs" ? w.flags.includes("waitingOnApproval") : w.completed;
  });
  return threadId;
}

// ---------------------------------------------------------------- OpenCode

/**
 * Through the background service's HTTP API, not `opencode run`: a non-interactive run rejects
 * permission requests on the spot, so it can never leave a session waiting for input.
 */
async function seedOpencode(s: Seed) {
  const svc = JSON.parse(readFileSync(`${HOME}/.local/state/opencode/service.json`, "utf8")) as { url: string; password: string };
  const headers = { authorization: `Basic ${btoa(`opencode:${svc.password}`)}`, "content-type": "application/json" };
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(svc.url + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`opencode ${path}: ${r.status} ${await r.text()}`);
    return ((await r.json()) as { data: any }).data;
  };
  const id: string = (await api("/api/session", { id: s.id, title: s.title, location: { directory: expand(s.dir) } })).id;
  await api(`/api/session/${id}/prompt`, { text: s.prompt });
  await until(`opencode ${id} ${s.expect}`, async () => {
    if (s.expect === "done") return (await api(`/api/session/${id}`)).outcome === "succeeded";
    const active = id in (await api("/api/session/active"));
    const asking = active && (await api(`/api/session/${id}/permission`)).length > 0;
    return s.expect === "needs" ? asking : active && !asking;
  });
  return id;
}

// ---------------------------------------------------------------- main

const [harness, dir, expect, ...words] = process.argv.slice(2);
const seeds: Seed[] = harness
  ? [{ harness: harness as Harness, dir: dir!, expect: expect as Expect, prompt: words.join(" "), title: words.join(" ") }]
  : (PLAN[hostname()] ?? []);
for (const s of seeds) mkdirSync(expand(s.dir), { recursive: true });

let rpc: CodexRpc | undefined;
if (seeds.some((s) => s.harness === "codex")) {
  rpc = new CodexRpc();
  rpc.onNotification = (method, params) => {
    if (method === "thread/status/changed") Object.assign(watch(params.threadId), { active: params.status.type === "active", flags: params.status.activeFlags ?? [] });
    else if (method === "turn/completed") watch(params.threadId).completed = true;
  };
  await rpc.connect(`${HOME}/.codex/app-server-control/app-server-control.sock`);
}

for (const s of seeds) {
  const id = s.harness === "claude" ? await seedClaude(s) : s.harness === "codex" ? await seedCodex(s, rpc!) : await seedOpencode(s);
  console.log(`seeded ${s.harness} ${s.expect} ${id} ${JSON.stringify(s.title)}`);
}
rpc?.close();
process.exit(0);
