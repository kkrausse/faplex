// The machine × harness of the last new session, kept in ~/.local/state/faplex/last-pick.json so
// the picker opens on it in the next dashboard too. A missing or unreadable file means no default.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Pick } from "./new-session.tsx";

const STATE_DIR = `${homedir()}/.local/state/faplex`;
const FILE = `${STATE_DIR}/last-pick.json`;

export function loadLastPick(): Pick | undefined {
  try {
    const p = JSON.parse(readFileSync(FILE, "utf8"));
    if (typeof p?.machine === "string" && typeof p?.harness === "string") return { machine: p.machine, harness: p.harness };
  } catch {}
  return undefined;
}

export function saveLastPick(p: Pick) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify({ machine: p.machine, harness: p.harness }));
  } catch {}
}
