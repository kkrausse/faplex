// `faplex watch --json`: the dashboard's data for another program, one JSON line per change on
// stdout. No renderer; the same sources and store as the dashboard. Each line is complete:
//   machines   id, short, whether it is remote, and the start dir a new session there defaults to
//   harnesses  the harnesses this config lists
//   lastPick   machine × harness of the last session started from any dashboard
//   sources    per machine × harness: loaded, and the problem if any (missing, not running, ...)
//   sessions   every row, `archived` as the dashboard counts it, plus its tags (tags.ts)
import type { Config } from "./config.ts";
import { dirKey, loadRemembered } from "./last-pick.ts";
import type { DashStore } from "./store.ts";
import { loadTags } from "./tags.ts";

const TICK_MS = 500;

export const defaultDir = (store: DashStore, machineId: string) => {
  const m = store.machine(machineId);
  return loadRemembered().dirs[dirKey(m.id, !!m.ssh)] ?? (m.ssh ? (m.dir ?? "~") : process.cwd());
};

export function watch(config: Config, store: DashStore) {
  let last = "";
  const tick = () => {
    const tags = loadTags();
    const line = JSON.stringify({
      machines: config.machines.map((m) => ({ id: m.id, short: m.short ?? m.id, remote: !!m.ssh, dir: defaultDir(store, m.id) })),
      harnesses: store.harnesses,
      lastPick: loadRemembered().pick ?? null,
      sources: Object.values(store.state.sources).map((s) => ({ machine: s.machine, harness: s.harness, loaded: s.loaded, problem: s.problem ?? null })),
      sessions: store.rows().map((s) => ({ ...s, archived: store.archivedOf(s), tags: tags[s.key] ?? [] })),
    });
    if (line === last) return;
    last = line;
    process.stdout.write(line + "\n");
  };
  setInterval(tick, TICK_MS);
  const quit = async () => {
    setTimeout(() => process.exit(0), 3000);
    await store.stop();
    process.exit(0);
  };
  // The reader went away: nobody is left to tell.
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(sig, () => void quit());
  process.stdout.on("error", () => void quit());
  process.stdin.on("end", () => void quit());
  process.stdin.resume();
  const parent = process.ppid;
  setInterval(() => {
    if (parent !== 1 && process.ppid === 1) void quit();
  }, 10_000).unref?.();
}
