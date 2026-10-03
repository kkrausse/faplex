// Dashboard archive marks live on each host, next to the sessions they describe, so every dashboard
// on any machine sees the same state: ~/.config/faplex/archive.json, keyed by `harness:id`.
// true = archived, false = explicitly restored (beats the 7-day rule), absent = default.
import { Effect, Schema } from "effect";
import { decodeJson, fail } from "./errors.ts";
import { sh, type Machine } from "./machines.ts";
import type { Session } from "./session.ts";

export const ARCHIVE_FILE = "$HOME/.config/faplex/archive.json";
export type Marks = Readonly<Record<string, boolean>>;

const decodeMarks = decodeJson(Schema.Record(Schema.String, Schema.Boolean), "archive.json");
export const parseMarks = (text: string) => (text.trim() ? decodeMarks(text) : Effect.succeed({} as Marks));

export const markKey = (s: Pick<Session, "harness" | "id">) => `${s.harness}:${s.id}`;

/** Read-modify-write on the host, replaced atomically; POSIX sh only (no jq/python/bun there). */
export const setMark = (m: Machine, key: string, archived: boolean) =>
  Effect.gen(function* () {
    const cur = yield* sh(m, `cat "${ARCHIVE_FILE}" 2>/dev/null || true`);
    const marks = { ...(yield* parseMarks(cur.stdout)), [key]: archived };
    const out = yield* sh(
      m,
      `d="$HOME/.config/faplex"; mkdir -p "$d" && t="$d/.archive.$$" && cat > "$t" && mv "$t" "$d/archive.json"`,
      { stdin: JSON.stringify(marks, null, 1) + "\n" },
    );
    if (out.code !== 0) return yield* fail("failed", out.stderr.trim() || "archive write failed");
    return marks as Marks;
  });

const WEEK = 7 * 24 * 3600 * 1000;

/** Harness archive, dashboard mark, or finished and untouched for 7 days (unless explicitly restored). */
export function isArchived(s: Session, marks: Marks | undefined, now: number): boolean {
  const mark = marks?.[markKey(s)];
  if (s.archived || mark === true) return true;
  if (mark === false || s.status === "needs" || s.status === "working") return false;
  return now - s.updatedAt > WEEK;
}
