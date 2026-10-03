// Every running dashboard leaves a file named after its pid in ~/.local/state/faplex/run, so
// `faplex ps` can list them and `faplex kill` can end the ones whose terminal is gone.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const RUN_DIR = `${homedir()}/.local/state/faplex/run`;

export function register() {
  mkdirSync(RUN_DIR, { recursive: true });
  const file = `${RUN_DIR}/${process.pid}`;
  writeFileSync(file, "");
  process.on("exit", () => rmSync(file, { force: true }));
}

type Dashboard = { pid: number; tty: string; started: string; orphaned: boolean };

function dashboards(): Dashboard[] {
  let names: string[] = [];
  try {
    names = readdirSync(RUN_DIR);
  } catch {}
  const found: Dashboard[] = [];
  for (const name of names) {
    const ps = Bun.spawnSync(["ps", "-o", "ppid=,tty=,lstart=,command=", "-p", name]).stdout.toString().trim();
    // The dashboard is gone (killed hard, so its file stayed), or its pid now belongs to something else.
    if (!/faplex|main\.tsx/.test(ps)) {
      rmSync(`${RUN_DIR}/${name}`, { force: true });
      continue;
    }
    const [ppid, tty, ...rest] = ps.split(/\s+/);
    // Adopted by init, or no terminal left: nobody is looking at it.
    found.push({ pid: Number(name), tty: tty!, started: rest.slice(0, 5).join(" "), orphaned: ppid === "1" || tty!.startsWith("?") });
  }
  return found;
}

/** `faplex ps` and `faplex kill [all]`; true when the arguments were one of them. */
export function command(args: string[]): boolean {
  if (args[0] !== "ps" && args[0] !== "kill") return false;
  const all = dashboards();
  if (args[0] === "ps") {
    for (const d of all) console.log(`${String(d.pid).padEnd(7)} ${d.tty.padEnd(8)} ${d.started}${d.orphaned ? "  orphaned" : ""}`);
    if (!all.length) console.log("no dashboards running");
    return true;
  }
  const targets = all.filter((d) => args[1] === "all" || d.orphaned);
  for (const d of targets) {
    process.kill(d.pid, "SIGTERM");
    console.log(`stopped ${d.pid} (${d.tty}, started ${d.started})`);
  }
  if (!targets.length) console.log(args[1] === "all" ? "no dashboards running" : "no orphaned dashboards · `faplex kill all` stops every one");
  return true;
}
