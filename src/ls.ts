// `faplex ls`: the session list once, for a program (or an agent) that wants a snapshot rather than
// `watch`'s stream. Waits for every source to report in (Claude takes seconds with many
// transcripts), then prints one line per session, newest first, or the rows as a JSON array.
// Archived sessions are left out unless --all. A source that failed is named on stderr; one that
// simply isn't there (not installed, daemon stopped) is not.
import { homedir } from "node:os";
import type { Command } from "./cli.ts";
import { QUIET } from "./errors.ts";
import { age } from "./format.ts";
import type { DashStore } from "./store.ts";
import { KEEP_TAG, loadTags } from "./tags.ts";

const WAIT_MS = 20_000;
const HOME = homedir();

export async function listOnce(store: DashStore, cmd: Extract<Command, { kind: "ls" }>): Promise<number> {
  const sources = () => Object.values(store.state.sources);
  for (const end = Date.now() + WAIT_MS; sources().some((s) => !s.loaded) && Date.now() < end; await Bun.sleep(100));
  for (const s of sources()) {
    if (!s.loaded) process.stderr.write(`faplex: ${s.harness} on ${s.machine} did not report in\n`);
    else if (s.problem && !QUIET.has(s.problem.kind)) process.stderr.write(`faplex: ${s.harness} on ${s.machine}: ${s.problem.message}\n`);
  }
  const tags = loadTags();
  const rows = store
    .rows()
    .map((s) => ({ ...s, archived: store.archivedOf(s, Date.now(), !!tags[s.key]?.includes(KEEP_TAG)), tags: tags[s.key] ?? [] }))
    .filter((s) => cmd.all || !s.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (cmd.json) {
    process.stdout.write(JSON.stringify(rows) + "\n");
    return 0;
  }
  for (const s of rows) {
    const detail = s.detail.split("\n")[0]!.trim();
    const fields = [s.key, s.status + (s.archived ? " archived" : ""), age(s.updatedAt) || "-", s.tags.join(",") || "-", JSON.stringify(s.title), detail && `· ${detail}`, `(${s.cwd.replace(HOME, "~")})`];
    process.stdout.write(fields.filter(Boolean).join("  ") + "\n");
  }
  return 0;
}
