// What the new-session picker opens on, kept in ~/.local/state/faplex/last-pick.json so the next
// dashboard has it too: the machine × harness of the last new session, and the start directory
// last used on each machine. A missing or unreadable file means no defaults.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Pick } from "./new-session.tsx";

const STATE_DIR = `${homedir()}/.local/state/faplex`;
const FILE = `${STATE_DIR}/last-pick.json`;

export type Remembered = { pick?: Pick; dirs: Record<string, string> };

/**
 * A remote machine has one remembered directory. This machine has one per directory the dashboard
 * was started in: there the default is that directory, until another one is picked from it.
 */
export const dirKey = (machine: string, remote: boolean) => (remote ? machine : `${machine}@${process.cwd()}`);

export function loadRemembered(): Remembered {
  try {
    const p = JSON.parse(readFileSync(FILE, "utf8"));
    const dirs = Object.fromEntries(Object.entries(p?.dirs ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
    return { pick: typeof p?.machine === "string" && typeof p?.harness === "string" ? { machine: p.machine, harness: p.harness } : undefined, dirs };
  } catch {
    return { dirs: {} };
  }
}

export function remember(p: Pick, key: string, dir: string) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify({ machine: p.machine, harness: p.harness, dirs: { ...loadRemembered().dirs, [key]: dir } }));
  } catch {}
}
