// Dashboard archive marks live on each host, next to the sessions they describe, so every dashboard
// on any machine sees the same state: ~/.config/faplex/archive.json, keyed by `harness:id`.
// A number = archived at that moment (the host's clock, ms): activity after it brings the session
// back. true = archived with no time (marks written before that). false = explicitly restored
// (beats the 7-day rule), absent = default.
import { Effect, Schema } from "effect";
import { decodeJson, fail } from "./errors.ts";
import { sh, type Machine } from "./machines.ts";
import type { Session } from "./session.ts";

export const ARCHIVE_FILE = "$HOME/.config/faplex/archive.json";
export type Mark = boolean | number;
export type Marks = Readonly<Record<string, Mark>>;

const decodeMarks = decodeJson(Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Number])), "archive.json");
export const parseMarks = (text: string) => (text.trim() ? decodeMarks(text) : Effect.succeed({} as Marks));

export const markKey = (s: Pick<Session, "harness" | "id">) => `${s.harness}:${s.id}`;

/**
 * Read-modify-write on the host, replaced atomically; POSIX sh only (no jq/python/bun there).
 * An archive is stamped with the host's own clock, the one its sessions' update times come from.
 */
export const setMark = (m: Machine, key: string, archived: boolean) =>
  Effect.gen(function* () {
    const cur = yield* sh(m, `date +%s; cat "${ARCHIVE_FILE}" 2>/dev/null || true`);
    const nl = cur.stdout.indexOf("\n");
    const at = Number(cur.stdout.slice(0, nl)) * 1000;
    if (nl <= 0 || !Number.isFinite(at)) return yield* fail("failed", cur.stderr.trim() || "archive read failed");
    const marks: Marks = { ...(yield* parseMarks(cur.stdout.slice(nl + 1))), [key]: archived ? at : false };
    const out = yield* sh(
      m,
      `d="$HOME/.config/faplex"; mkdir -p "$d" && t="$d/.archive.$$" && cat > "$t" && mv "$t" "$d/archive.json"`,
      { stdin: JSON.stringify(marks, null, 1) + "\n" },
    );
    if (out.code !== 0) return yield* fail("failed", out.stderr.trim() || "archive write failed");
    return marks;
  });

const WEEK = 7 * 24 * 3600 * 1000;
// Stopping a session touches it once more just after the mark is written; that is not new activity.
const SETTLE = 30_000;

/**
 * Harness archive, a dashboard mark with nothing happening since, or finished and untouched for
 * 7 days (unless explicitly restored).
 */
export function isArchived(s: Session, marks: Marks | undefined, now: number): boolean {
  const mark = marks?.[markKey(s)];
  if (s.archived || mark === true) return true;
  if (typeof mark === "number" && s.updatedAt <= mark + SETTLE) return true;
  if (mark === false || s.status === "needs" || s.status === "working") return false;
  return now - s.updatedAt > WEEK;
}
