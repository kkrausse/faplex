// Claude Code has no subscribe API, so each host runs ONE long-lived POSIX sh loop over the shared
// connection that prints a framed record every 2 s, and at once for each line on its stdin (the
// dashboard asks for one when it knows a status just changed, e.g. leaving a session pane): the host's archive marks, `claude agents --json
// --all`, the state.json of each listed background job (detail line, pending question, running
// subagents), and from each listed session's transcript its last response's usage line plus how
// many subagent transcripts sit next to it. Files are re-sent only when their mtime changes. The same loop runs locally, so local and remote
// are one code path. A host with no claude still runs the loop for its archive marks.
import { Effect, Schema, Stream } from "effect";
import { decodeJson, fail, firstLine, type SourceError } from "./errors.ts";
import { exec, lines, type Machine } from "./machines.ts";
import { ARCHIVE_FILE } from "./archive.ts";
import { sessionKey, type Background, type ContextUsage, type Session, type Status } from "./session.ts";

const TICK_S = 2;

// A ticker and stdin feed one pipe; each line on it is one record. The record's commands read
// /dev/null so they can't eat those lines. Nothing kills the pipeline's subshells for us: killing
// the stream's process only takes the top-level sh (or ssh), and Bun starts children with SIGPIPE
// ignored, so a write to the dead dashboard's stdout just fails and the loop used to poll on
// forever as an orphan. So the reader quits when its write fails or the top-level sh ($$) is gone,
// and the ticker when either of those took the reader.
const LOOP = `
J="$HOME/.claude/jobs"; P="$HOME/.claude/projects"; seen=""; seent=""
{ while kill -0 $$ 2>/dev/null && echo; do sleep ${TICK_S}; done & cat; } | while read -r _; do {
  kill -0 $$ 2>/dev/null || exit
  echo "@@archive" || exit; cat "${ARCHIVE_FILE}" 2>/dev/null; echo
  if command -v claude >/dev/null 2>&1; then
    out=$(claude agents --json --all 2>&1); echo "@@claude $?"; printf '%s\\n' "$out"
    next=""
    for id in $(printf '%s\\n' "$out" | sed -n 's/^ *"id": *"\\([A-Za-z0-9_-]*\\)".*/\\1/p'); do
      f="$J/$id/state.json"; [ -f "$f" ] || continue
      t=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")
      next="$next $id:$t"
      case " $seen " in *" $id:$t "*) echo "@@job $id $t same" ;; *) echo "@@job $id $t"; cat "$f"; echo ;; esac
    done
    seen=$next
    next=""
    for sid in $(printf '%s\\n' "$out" | sed -n 's/^ *"sessionId": *"\\([A-Za-z0-9_-]*\\)".*/\\1/p'); do
      for f in "$P"/*/"$sid".jsonl; do
        [ -f "$f" ] || continue
        t=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")
        n=$(ls "\${f%.jsonl}/subagents" 2>/dev/null | grep -c '^agent-.*\\.jsonl$')
        next="$next $sid:$t"
        case " $seent " in *" $sid:$t "*) echo "@@ctx $sid $t $n same" ;; *)
          echo "@@ctx $sid $t $n"
          tail -c 400000 "$f" | grep -e '"usage":{"input_tokens"' -e '"subtype":"compact_boundary"' | grep -v '"model":"<synthetic>"' | tail -n 1 ;;
        esac
      done
    done
    seent=$next
  else echo "@@claude missing"; fi
  echo "@@end"
} </dev/null; done`;

type Job = { mtime: number; text: string };
/** By session id: the transcript's last usage (or compaction) line and its subagent transcript count. */
type Transcript = Job & { subagents: number };

/** One tick of a host's loop. Job and transcript texts carry over from earlier records when unchanged. */
export type HostRecord = {
  archive: string;
  claude: { missing: true } | { missing: false; code: number; out: string; jobs: ReadonlyMap<string, Job>; transcripts: ReadonlyMap<string, Transcript> };
};

type Pending = { text: string[] | string };
type Draft = { archive: string[]; head?: string; out: string[]; jobs: Map<string, Pending & { mtime: number }>; transcripts: Map<string, Pending & { mtime: number; subagents: number }> };
type Acc = { cur?: Draft; section?: "archive" | "claude" | Pending; prevJobs: Map<string, Job>; prevTranscripts: Map<string, Transcript> };
const joined = (p: Pending) => (typeof p.text === "string" ? p.text : p.text.join("\n"));

function step(acc: Acc, line: string): readonly [Acc, HostRecord[]] {
  if (!line.startsWith("@@")) {
    const c = acc.cur, s = acc.section;
    if (!c || !s) return [acc, []];
    if (s === "archive") c.archive.push(line);
    else if (s === "claude") c.out.push(line);
    else (s.text as string[]).push(line);
    return [acc, []];
  }
  const [tag, a, b, same, sameCtx] = line.split(" ");
  const c: Draft = (acc.cur ??= { archive: [], out: [], jobs: new Map(), transcripts: new Map() });
  if (tag === "@@archive") acc.section = "archive";
  else if (tag === "@@claude") (c.head = a), (acc.section = "claude");
  else if (tag === "@@job" && a) {
    const prev = acc.prevJobs.get(a);
    const job = { mtime: Number(b) * 1000, text: same && prev ? prev.text : [] };
    c.jobs.set(a, job);
    acc.section = same ? undefined : job;
  } else if (tag === "@@ctx" && a) {
    // Here the fourth word is the subagent count, which changes without the transcript changing.
    const prev = acc.prevTranscripts.get(a);
    const t = { mtime: Number(b) * 1000, subagents: Number(same) || 0, text: sameCtx && prev ? prev.text : [] };
    c.transcripts.set(a, t);
    acc.section = sameCtx ? undefined : t;
  } else if (tag === "@@end") {
    const jobs = new Map([...c.jobs].map(([id, j]) => [id, { mtime: j.mtime, text: joined(j) }]));
    const transcripts = new Map([...c.transcripts].map(([id, t]) => [id, { mtime: t.mtime, subagents: t.subagents, text: joined(t) }]));
    const rec: HostRecord = {
      archive: c.archive.join("\n"),
      claude: c.head === "missing" || c.head === undefined ? { missing: true } : { missing: false, code: Number(c.head), out: c.out.join("\n"), jobs, transcripts },
    };
    return [{ prevJobs: jobs, prevTranscripts: transcripts }, [rec]];
  }
  return [acc, []];
}

/**
 * The host's records. Every tick emits, so silence means a stuck loop: after ~3 missed ticks the
 * stream fails and the caller's retry restarts the command. While running, `setRefresh` holds a
 * function that asks for a record now.
 */
export const hostFeed = (m: Machine, setRefresh: (refresh: (() => void) | undefined) => void): Stream.Stream<HostRecord, SourceError> =>
  lines(m, ["sh", "-c", LOOP], (write) => setRefresh(write && (() => write("\n")))).pipe(
    Stream.mapAccum(() => ({ prevJobs: new Map(), prevTranscripts: new Map() }) as Acc, step),
    Stream.timeoutOrElse({ duration: `${TICK_S * 3 + 3} seconds`, orElse: () => Stream.fail(fail("failed", `${m.id}: claude loop stalled`)) }),
  );

const Entry = Schema.Struct({
  pid: Schema.optionalKey(Schema.Number),
  id: Schema.optionalKey(Schema.String),
  sessionId: Schema.String,
  kind: Schema.String,
  cwd: Schema.String,
  name: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.Number),
  status: Schema.optionalKey(Schema.String),
  waitingFor: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
});
const decodeEntries = decodeJson(Schema.Array(Entry), "claude agents --json");

const JobState = Schema.Struct({
  detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  needs: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // The top level's own turn: "active" while it runs, "blocked" on the user, "idle" once it ended.
  tempo: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // What the session started in the background (subagents, shells); an entry without `doneAt` is still running.
  fan: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({
    kind: Schema.optionalKey(Schema.String), label: Schema.optionalKey(Schema.NullOr(Schema.String)), doneAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  })))),
});
const decodeJob = decodeJson(JobState, "state.json");

const Usage = Schema.Struct({
  timestamp: Schema.String,
  message: Schema.Struct({
    model: Schema.String,
    usage: Schema.Struct({
      input_tokens: Schema.Number,
      cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  }),
});
const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(Usage));

/**
 * Context as Claude's own status line counts it: the last response's input tokens, cached or not.
 * `line` is the transcript's last usage line; a compaction after it (or a line cut off by the
 * host's tail) doesn't decode, and means unavailable until the next response. No limit: the
 * transcript doesn't record the window size.
 */
export function claudeContext(line: string): { usage: ContextUsage; model: string } | undefined {
  const decoded = decodeUsage(line);
  if (decoded._tag === "None") return undefined;
  const { timestamp, message: { model, usage: u } } = decoded.value;
  const usedTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return undefined;
  return { model, usage: { usedTokens, measuredAt: Date.parse(timestamp) || Date.now() } };
}

// Paseo runs Claude headless (stream-json, no TTY); its sessions are only answerable from paseotui.
// Uses local ps, so it is only checked on the local machine.
function underPaseo(pid: number | undefined): boolean {
  if (!pid) return false;
  const ppid = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]).stdout.toString().trim();
  return !!ppid && Bun.spawnSync(["ps", "-o", "comm=", "-p", ppid]).stdout.toString().includes("Paseo");
}

const background = (running: readonly { label?: string | null }[], kind: Background["kind"]): Background | undefined =>
  running.length ? { kind, count: running.length, label: running[0]!.label ?? "" } : undefined;

/** Sessions from one record; `missing` when the host has no claude. */
export const claudeSessions = (m: Machine, rec: HostRecord): Effect.Effect<Session[], SourceError> =>
  Effect.gen(function* () {
    const c = rec.claude;
    if (c.missing) return yield* fail("missing", "not installed");
    // Older Claude Code (before background agents) has no `agents --json`.
    if (c.code !== 0 && /unknown option '--json'/.test(c.out)) return yield* fail("unsupported", "claude too old for agents --json");
    if (c.code !== 0) return yield* fail("failed", `claude agents: ${firstLine(c.out) || `exit ${c.code}`}`);
    const entries = yield* decodeEntries(c.out);
    return yield* Effect.forEach(entries, (e) =>
      Effect.gen(function* () {
        const raw = e.id ? c.jobs.get(e.id) : undefined;
        // A half-written state.json only costs this tick's detail line.
        const job = raw ? yield* decodeJob(raw.text).pipe(Effect.orElseSucceed(() => ({}) as typeof JobState.Type)) : undefined;
        // A fresh `claude --bg` session reports "blocked" until its first prompt.
        const unprompted = /send a prompt to start/.test(job?.needs ?? "");
        const running = (kind: string) => job?.fan?.filter((f) => f.kind === kind && !f.doneAt) ?? [];
        const agents = running("agent"), shells = running("shell");
        // `status` is the process (busy / waiting / idle); `state` is the session's own account of its
        // task, which stays "working" when a turn ends without declaring it done. So activity comes
        // from `status`, `state` only says how an idle session ended (or stands in when `status` is absent).
        const proc = e.status ?? (e.state === "blocked" ? "waiting" : e.state === "working" ? "busy" : "idle");
        // But the process is also busy for as long as anything it started is running: a dev server
        // left up after the last turn, a subagent, a shell loop that never exits. The job's `tempo`
        // is the top level's own turn, so a live process's tempo decides what "busy" means. A dead
        // process leaves its last tempo behind, so then only `state` counts.
        const tempo = e.status ? (job?.tempo ?? undefined) : undefined;
        const status: Status =
          unprompted ? "idle"
          : proc === "waiting" || (tempo ? tempo === "blocked" : e.state === "blocked") ? "needs"
          // A turn that ended with subagents out is woken by their results; a shell may never finish.
          : proc === "busy" && (tempo !== "idle" || agents.length) ? "working"
          : e.state === "done" ? "done"
          : e.state === "failed" ? "failed"
          : e.state === "interrupted" || e.state === "stopped" || e.state === "killed" ? "interrupted"
          : "idle";
        // The job's last note (what it is doing, or where it left off).
        const detail = status === "needs" ? (job?.needs ?? e.waitingFor ?? "waiting") : unprompted ? "" : (job?.detail ?? "");
        const transcript = c.transcripts.get(e.sessionId);
        const context = transcript && claudeContext(transcript.text);
        const bg = e.kind === "background" && e.id;
        const paseo = !bg && !m.ssh && underPaseo(e.pid);
        const id = e.id ?? e.sessionId;
        return {
          machine: m.id,
          harness: "claude",
          key: sessionKey(m.id, "claude", id),
          id,
          title: (e.name ?? e.sessionId.slice(0, 8)) + (paseo ? " (paseo)" : ""),
          cwd: e.cwd,
          status,
          prompted: unprompted ? false : job?.needs || job?.detail ? true : undefined,
          // Every subagent the session ever started has a transcript; only a background job says
          // which are running now.
          subagents: transcript?.subagents ? { total: transcript.subagents, active: agents.length, complete: true } : undefined,
          background: background(agents, "agent") ?? background(shells, "shell"),
          context: context?.usage,
          detail,
          model: context?.model ?? "",
          updatedAt: raw?.mtime ?? e.startedAt ?? 0,
          archived: false,
          // A finished background session keeps its process, and with it any /loop or wakeup that can
          // start it again. Interactive sessions belong to their terminal.
          stoppable: !!bg && e.state !== "stopped" && e.state !== "killed",
          // An interactive session is owned by the terminal it runs in; a second client would fork it.
          open: bg ? { cmd: ["claude", "attach", e.id!], cwd: e.cwd } : paseo ? { cmd: ["paseotui"], cwd: e.cwd } : undefined,
          closedReason: bg || paseo ? undefined : "interactive session · open it in its own terminal",
        } satisfies Session;
      }),
    );
  });

/** An idle background session ("send a prompt to start"), so it stays attachable. */
export const launchClaude = (m: Machine, dir: string) =>
  Effect.gen(function* () {
    const out = yield* exec(m, ["claude", "--bg"], { cwd: dir, timeout: 60_000 }).pipe(Effect.map((o) => o.stdout + o.stderr));
    const id = out.replace(/\x1b\[[0-9;]*m/g, "").match(/backgrounded · (\w+)/)?.[1];
    if (!id) return yield* fail("failed", firstLine(out) || "claude --bg printed no id");
    return { cmd: ["claude", "attach", id], cwd: dir, claim: { id } };
  });


/** Ends the background session's process (and its pending wakeups); `claude attach` resumes it. */
export const stopClaude = (m: Machine, id: string) =>
  Effect.gen(function* () {
    const out = yield* exec(m, ["claude", "stop", id]);
    // Already exited: nothing left to stop.
    if (out.code !== 0 && !/No job matching/.test(out.stdout + out.stderr)) return yield* fail("failed", `claude stop: ${firstLine(out.stderr || out.stdout) || `exit ${out.code}`}`);
  });
