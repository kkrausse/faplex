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
type Seed = { harness: Harness; dir: string; title: string; prompt: string; expect: Expect };

const HOME = homedir();
const TIMEOUT_MS = 60_000;

// The fake API decides where a prompt ends up: "dependency audit" / "flaky checkout" / "migrate … to"
// hold the stream open (Working), "rate limit" / "clean up" / "drop the" ask to run a shell command
// (Needs input), anything else is answered (Finished). `expect` is what the seed waits for.
// Every harness appears once in every state.
const PLAN: Record<string, Seed[]> = {
  laptop: [
    { harness: "claude", dir: "~/src/shop-api", title: "Fix flaky checkout test", prompt: "fix the flaky checkout test", expect: "working" },
    { harness: "codex", dir: "~/src/shop-api", title: "Add rate limiting to public API", prompt: "add rate limiting to the public API", expect: "needs" },
    { harness: "opencode", dir: "~/src/site", title: "Tidy the landing page copy", prompt: "tidy the landing page copy", expect: "done" },
  ],
  devbox: [
    { harness: "codex", dir: "~/src/infra", title: "Nightly dependency audit", prompt: "run the nightly dependency audit", expect: "working" },
    { harness: "opencode", dir: "~/src/infra", title: "Drop the staging tables", prompt: "drop the staging tables", expect: "needs" },
    { harness: "claude", dir: "~/src/infra", title: "Bump the terraform provider", prompt: "bump the terraform provider", expect: "done" },
  ],
  pi: [
    { harness: "opencode", dir: "~/src/site", title: "Migrate cron jobs to systemd timers", prompt: "migrate the cron jobs to systemd timers", expect: "working" },
    { harness: "claude", dir: "~/src/site", title: "Clean up stale nginx configs", prompt: "clean up the stale nginx configs", expect: "needs" },
    { harness: "codex", dir: "~/src/site", title: "Document the backup script", prompt: "document the backup script", expect: "done" },
  ],
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
  const id: string = (await api("/api/session", { title: s.title, location: { directory: expand(s.dir) } })).id;
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
