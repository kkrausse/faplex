// The edge between Effect and Solid: one fiber per source (machine × harness) runs its stream and
// replaces that source's rows in the Solid store on every item. Failures land in the store as the
// source's problem and are retried: quiet ones (not installed / not running) every minute, real
// ones with capped exponential backoff.
import { createStore, reconcile } from "solid-js/store";
import { Duration, Effect, Fiber, Schedule, Stream } from "effect";
import type { Harness, Session } from "./session.ts";
import { HARNESSES } from "./session.ts";
import { QUIET, fail, type SourceError } from "./errors.ts";
import { closeMaster, expand, home, loadMachines, localName, type Machine } from "./machines.ts";
import { claudeSessions, hostFeed, launchClaude, stopClaude } from "./claude.ts";
import { launchOpencode, opencodeSessions } from "./opencode.ts";
import { codexSessions, launchCodex } from "./codex.ts";
import { isArchived, parseMarks, setMark, markKey, type Mark, type Marks } from "./archive.ts";
import type { Claim } from "./session.ts";
import { HOST_COLORS } from "./theme.ts";

export type Problem = { kind: SourceError["kind"]; message: string };
export type Source = { machine: string; harness: Harness; rows: Session[]; problem?: Problem; loaded: boolean };
export const sourceKey = (machine: string, harness: Harness) => `${machine}/${harness}`;

/** What to run in a new session's pane, and how to recognize the session once its source reports it. */
export type Launch = { cmd: string[]; cwd: string; claim: Claim };

const retryPolicy = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<SourceError>(),
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(QUIET.has(input.kind) ? Duration.seconds(60) : Duration.min(duration, Duration.seconds(30))),
  ),
);

export type DashStore = ReturnType<typeof createDashStore>;

export function createDashStore() {
  const machines = loadMachines();
  const [state, setState] = createStore({
    sources: Object.fromEntries(
      machines.flatMap((m) => HARNESSES.map((h) => [sourceKey(m.id, h), { machine: m.id, harness: h, rows: [], loaded: false } as Source])),
    ) as Record<string, Source>,
    marks: {} as Record<string, Marks>,
    // Sessions being stopped and archived right now, and the ones whose stop failed. A row counts
    // as archived from the keypress, so it leaves its section once instead of following the stop
    // and the mark as two separate changes.
    archiving: {} as Record<string, { failed?: string }>,
  });

  const setRows = (k: string, rows: readonly Session[]) =>
    Effect.sync(() => {
      setState("sources", k, "rows", reconcile([...rows], { key: "key" }));
      setState("sources", k, { problem: undefined, loaded: true });
    });
  const setProblem = (k: string, e: SourceError) =>
    Effect.sync(() => {
      setState("sources", k, { problem: { kind: e.kind, message: e.message }, loaded: true });
      // Quiet states have no rows; a real failure keeps the last known rows on screen.
      if (QUIET.has(e.kind)) setState("sources", k, "rows", []);
    });

  /** Run until interrupted: a stream ending is a failure like any other, so it restarts. */
  const supervise = (k: string, run: Effect.Effect<void, SourceError>) =>
    run.pipe(
      Effect.andThen(Effect.fail(fail("failed", "stream ended"))),
      Effect.tapError((e) => setProblem(k, e)),
      Effect.retry(retryPolicy),
    );

  const refreshers = new Map<string, () => void>();

  // A host record read just before a mark was written still carries the old file; marks written
  // here win over it for a few seconds, or the row would jump back until the next record.
  const WRITTEN_MS = 10_000;
  const written = new Map<string, Map<string, { value: Mark; at: number }>>();
  const setMarks = (machineId: string, marks: Marks) => {
    const mine = written.get(machineId);
    for (const [key, w] of mine ?? []) if (Date.now() - w.at > WRITTEN_MS) mine!.delete(key);
    setState("marks", machineId, reconcile({ ...marks, ...Object.fromEntries([...(mine ?? [])].map(([key, w]) => [key, w.value])) }));
  };
  // One read-modify-write per host at a time, so archiving several rows in a row loses none.
  const writes = new Map<string, Promise<unknown>>();

  // The host loop carries both the archive marks and the Claude rows; a Claude problem on one
  // tick (not installed, bad JSON) doesn't stop the loop.
  const claude = (m: Machine) => {
    const k = sourceKey(m.id, "claude");
    return supervise(
      k,
      hostFeed(m, (f) => void (f ? refreshers.set(m.id, f) : refreshers.delete(m.id))).pipe(
        Stream.runForEach((rec) =>
          Effect.gen(function* () {
            const marks = yield* parseMarks(rec.archive).pipe(Effect.option);
            if (marks._tag === "Some") setMarks(m.id, marks.value);
            yield* claudeSessions(m, rec).pipe(
              Effect.matchEffect({ onSuccess: (rows) => setRows(k, rows), onFailure: (e) => setProblem(k, e) }),
            );
          }),
        ),
      ),
    );
  };
  // Codex and OpenCode stop through their source's live connection, so each source publishes its
  // stop function while connected.
  const stoppers = new Map<string, (id: string) => Effect.Effect<void, SourceError>>();
  const setStop = (k: string) => (f: ((id: string) => Effect.Effect<void, SourceError>) | undefined) => void (f ? stoppers.set(k, f) : stoppers.delete(k));

  const streamed = (m: Machine, h: Harness, s: Stream.Stream<ReadonlyArray<Session>, SourceError>) =>
    supervise(sourceKey(m.id, h), s.pipe(Stream.runForEach((rows) => setRows(sourceKey(m.id, h), rows))));

  const program = Effect.forEach(
    machines,
    (m) =>
      Effect.all(
        [
          claude(m),
          streamed(m, "opencode", Stream.unwrap(home(m).pipe(Effect.map((h) => opencodeSessions(m, h, setStop(sourceKey(m.id, "opencode"))))))),
          streamed(m, "codex", codexSessions(m, setStop(sourceKey(m.id, "codex")))),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    { concurrency: "unbounded", discard: true },
  );

  let fiber: Fiber.Fiber<void, SourceError> | undefined;
  const machine = (id: string) => machines.find((m) => m.id === id)!;

  const stopSession = (s: Session): Promise<void> => {
    if (!s.stoppable) return Promise.resolve();
    if (s.harness === "claude") return Effect.runPromise(stopClaude(machine(s.machine), s.id).pipe(Effect.tap(() => Effect.sync(() => refreshers.get(s.machine)?.()))));
    const stop = stoppers.get(sourceKey(s.machine, s.harness));
    return stop ? Effect.runPromise(stop(s.id)) : Promise.reject(new Error(`${s.machine}·${s.harness} not connected`));
  };
  const mark = (s: Session, archived: boolean): Promise<void> => {
    const key = markKey(s);
    const run = () =>
      Effect.runPromise(setMark(machine(s.machine), key, archived)).then((marks) => {
        if (!written.has(s.machine)) written.set(s.machine, new Map());
        written.get(s.machine)!.set(key, { value: marks[key]!, at: Date.now() });
        setMarks(s.machine, marks);
      });
    const next = (writes.get(s.machine) ?? Promise.resolve()).then(run, run);
    writes.set(s.machine, next.catch(() => {}));
    return next;
  };
  const archivedOf = (s: Session, now = Date.now()) => {
    const a = state.archiving[s.key];
    return (!!a && a.failed === undefined) || isArchived(s, state.marks[s.machine], now);
  };

  return {
    state,
    machines,
    machine,
    /** Archived, counting a session that is being archived right now. */
    archivedOf,
    /** The machine this dashboard runs on (its entry without `ssh`, else its Tailscale name). */
    here: machines.find((m) => !m.ssh)?.id ?? localName(),
    start: () => void (fiber = Effect.runFork(program)),
    /** Interrupt every source (cancelling forwards), then close the shared connections. */
    stop: async () => {
      if (fiber) await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds"), Effect.ignore));
      machines.forEach(closeMaster);
    },
    /** The machine's name in list rows: its `short` in machines.json, else its id. */
    hostShort: (id: string) => machines.find((m) => m.id === id)?.short ?? id,
    /** The machine's color: its `color` in machines.json, else one from the palette by config order. */
    hostColor: (id: string) => {
      const i = machines.findIndex((m) => m.id === id);
      return machines[i]?.color ?? HOST_COLORS[Math.max(0, i) % HOST_COLORS.length]!;
    },
    /**
     * Ask the machine's Claude loop for a record now instead of at its next tick. Codex and OpenCode
     * push their changes, so they need no asking.
     */
    refresh: (machineId: string) => refreshers.get(machineId)?.(),
    /** End whatever is still running in the session, so nothing can start it again unprompted. */
    stopSession,
    rows: (h?: Harness) => Object.values(state.sources).flatMap((s) => (!h || s.harness === h ? s.rows : [])),
    /** Write a dashboard archive mark on the session's own host. */
    mark,
    /**
     * Stop the session, then mark it. It is archived either way: resolves with the stop's error
     * when that failed (the session is still running and `x` again retries), and rejects only
     * when the mark couldn't be written, which leaves the session where it was.
     */
    archive: async (s: Session): Promise<string | undefined> => {
      // Not `{}`: that would merge into a failed entry and keep its error.
      setState("archiving", s.key, { failed: undefined });
      const failed = await stopSession(s).then(
        () => undefined,
        (e) => (e instanceof Error ? e.message : String(e)),
      );
      try {
        await mark(s, true);
      } catch (e) {
        setState("archiving", s.key, undefined!);
        throw e;
      }
      setState("archiving", s.key, failed === undefined ? undefined! : { failed });
      return failed;
    },
    /** Opening a session brings it back from the archive (not from the harness's own archive). */
    reopened: (s: Session) => {
      if (!s.id || s.archived || !archivedOf(s)) return;
      setState("archiving", s.key, undefined!);
      mark(s, false).catch(() => {});
    },
    launch: (machineId: string, h: Harness, dir: string): Promise<Launch> => {
      const m = machine(machineId);
      return Effect.runPromise(
        expand(m, dir).pipe(
          Effect.flatMap((d): Effect.Effect<Launch, SourceError> => (h === "claude" ? launchClaude(m, d) : h === "opencode" ? launchOpencode(d) : launchCodex(d))),
        ),
      );
    },
  };
}
