// Tags another program put on a session (`faplex new --tag`), e.g. the ticket it was started for.
// Kept on this machine, in ~/.local/state/faplex/tags.json keyed by session key; `watch` lists
// them with each session. A missing or unreadable file means no tags.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const STATE_DIR = `${homedir()}/.local/state/faplex`;
const FILE = `${STATE_DIR}/tags.json`;

export type Tags = Record<string, string[]>;

export function loadTags(): Tags {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    return Object.fromEntries(
      Object.entries(raw ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? [[k, v.filter((t): t is string => typeof t === "string")]] : [])),
    );
  } catch {
    return {};
  }
}

export function addTags(key: string, tags: readonly string[]) {
  if (!tags.length) return;
  const all = loadTags();
  all[key] = [...new Set([...(all[key] ?? []), ...tags])];
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(all, null, 1) + "\n");
  renameSync(tmp, FILE);
}
