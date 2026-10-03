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
import { parseMarks, setMark, markKey, type Marks } from "./archive.ts";
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
            if (marks._tag === "Some") setState("marks", m.id, reconcile({ ...marks.value }));
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

  return {
    state,
    machines,
    machine,
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
    stopSession: (s: Session): Promise<void> => {
      if (!s.stoppable) return Promise.resolve();
      if (s.harness === "claude") return Effect.runPromise(stopClaude(machine(s.machine), s.id).pipe(Effect.tap(() => Effect.sync(() => refreshers.get(s.machine)?.()))));
      const stop = stoppers.get(sourceKey(s.machine, s.harness));
      return stop ? Effect.runPromise(stop(s.id)) : Promise.reject(new Error(`${s.machine}·${s.harness} not connected`));
    },
    rows: (h?: Harness) => Object.values(state.sources).flatMap((s) => (!h || s.harness === h ? s.rows : [])),
    /** Write a dashboard archive mark on the session's own host. */
    mark: (s: Session, archived: boolean) =>
      Effect.runPromise(
        setMark(machine(s.machine), markKey(s), archived).pipe(Effect.tap((marks) => Effect.sync(() => setState("marks", s.machine, reconcile({ ...marks }))))),
      ),
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
