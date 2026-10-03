// Codex: the shared app-server daemon owns every TUI's threads, so its thread/list status is live.
// Its control socket is forwarded per host; thread notifications (status, start, archive, rename)
// trigger a re-list.
import { Cause, Effect, Queue, Schema, Stream } from "effect";
import { CodexRpc } from "./codex-rpc.ts";
import { decodeValue, fail, type SourceError } from "./errors.ts";
import { forward, sh, type Machine } from "./machines.ts";
import { sessionKey, type ContextUsage, type Session, type Status } from "./session.ts";
import { subagentSummary } from "./metrics.ts";
import { readPages } from "./pages.ts";

const CHECK = `
command -v codex >/dev/null 2>&1 || { echo "@@missing"; exit 0; }
s="$HOME/.codex/app-server-control/app-server-control.sock"
if [ -S "$s" ]; then echo "@@sock $s"; else echo "@@nosock"; fi`;

const Thread = Schema.Struct({
  id: Schema.String,
  parentThreadId: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  preview: Schema.String,
  model: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  updatedAt: Schema.Number,
  status: Schema.Struct({ type: Schema.String, activeFlags: Schema.optionalKey(Schema.Array(Schema.String)) }),
});
const decodeList = decodeValue(Schema.Struct({ data: Schema.Array(Thread), nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)) }), "codex thread/list");
const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];

const TokenUsage = Schema.Struct({ threadId: Schema.String, tokenUsage: Schema.Struct({
  last: Schema.Struct({ totalTokens: Schema.Number }), modelContextWindow: Schema.NullOr(Schema.Number),
}) });
export function codexContext(value: unknown, now = Date.now()) {
  const decoded = Schema.decodeUnknownOption(TokenUsage)(value);
  if (decoded._tag === "None") return undefined;
  const { threadId, tokenUsage: { last, modelContextWindow } } = decoded.value;
  if (!Number.isFinite(last.totalTokens) || last.totalTokens <= 0) return undefined;
  const usage: ContextUsage = { usedTokens: last.totalTokens, measuredAt: now,
    limitTokens: modelContextWindow && Number.isFinite(modelContextWindow) && modelContextWindow > 0 ? modelContextWindow : undefined };
  return { threadId, usage };
}

const RELEVANT = new Set(["thread/started", "thread/status/changed", "thread/archived", "thread/unarchived", "thread/deleted", "thread/closed", "thread/name/updated"]);

const request = (c: CodexRpc, method: string, params: unknown) =>
  Effect.tryPromise({ try: () => c.request(method, params), catch: (e) => fail("failed", `codex ${method}: ${e instanceof Error ? e.message : String(e)}`) });

const list = (m: Machine, c: CodexRpc, contexts: Map<string, ContextUsage>) =>
  Effect.gen(function* () {
    const page = (archived: boolean) =>
      readPages((cursor) => request(c, "thread/list", { limit: 100, sortKey: "updated_at", useStateDbOnly: true, archived, sourceKinds: SOURCE_KINDS, cursor }).pipe(
        Effect.flatMap(decodeList), Effect.map((p) => ({ items: p.data, next: p.nextCursor, hasCursor: p.nextCursor !== undefined })),
      ));
    const [live, archived] = yield* Effect.all([page(false), page(true)], { concurrency: 2 });
    const done = new Set(live.items.map((t) => t.id));
    const threads = [...live.items, ...archived.items.filter((t) => !done.has(t.id))];
    const ids = new Set(threads.map((t) => t.id));
    for (const id of contexts.keys()) if (!ids.has(id)) contexts.delete(id);
    const nodes = threads.map((t) => ({ id: t.id, parentId: t.parentThreadId, active: t.status.type === "active" }));
    return threads
      .filter((t) => !t.parentThreadId)
      .map((t): Session => {
        const flags = t.status.type === "active" ? (t.status.activeFlags ?? []) : [];
        const status: Status =
          flags.length ? "needs"
          : t.status.type === "active" ? "working"
          : t.status.type === "systemError" ? "failed"
          : t.preview ? "done"
          : "idle";
        return {
          machine: m.id,
          harness: "codex",
          key: sessionKey(m.id, "codex", t.id),
          id: t.id,
          title: t.name || t.preview.split("\n")[0] || t.id,
          cwd: t.cwd,
          status,
          prompted: !!t.preview,
          subagents: subagentSummary(nodes, t.id, live.complete && archived.complete),
          context: contexts.get(t.id),
          detail: flags.includes("waitingOnApproval") ? "approval" : flags.includes("waitingOnUserInput") ? "input" : "",
          model: t.model ?? "",
          updatedAt: t.updatedAt * 1000,
          archived: !done.has(t.id),
          stoppable: t.status.type === "active",
          open: { cmd: ["codex", "resume", t.id], cwd: t.cwd },
        };
      });
  });

const Turns = decodeValue(Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })) }), "codex thread/turns/list");

/** Interrupts the thread's in-progress turn, if any. Codex threads never wake on their own. */
const stopThread = (c: CodexRpc, threadId: string) =>
  Effect.gen(function* () {
    const turns = yield* request(c, "thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }).pipe(Effect.flatMap(Turns));
    const turn = turns.data.find((t) => t.status === "inProgress");
    if (turn) yield* request(c, "turn/interrupt", { threadId, turnId: turn.id });
  });

/**
 * The machine's Codex threads: the full list on connect, on each thread notification, and every 60 s.
 * While connected, `setStop` holds a function that stops a thread over the same connection.
 */
export const codexSessions = (m: Machine, setStop: (stop: ((id: string) => Effect.Effect<void, SourceError>) | undefined) => void): Stream.Stream<ReadonlyArray<Session>, SourceError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const out = (yield* sh(m, CHECK)).stdout.trim();
      if (out === "@@missing") return yield* fail("missing", "not installed");
      if (!out.startsWith("@@sock ")) return yield* fail("stopped", "app-server not running");
      const path = yield* forward(m, { unix: out.slice(7) });
      const rpc = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            const c = new CodexRpc();
            await c.connect(path);
            return c;
          },
          catch: (e) => fail("failed", `codex connect: ${e instanceof Error ? e.message : String(e)}`),
        }),
        (c) => Effect.sync(() => c.close()),
      );
      const contexts = new Map<string, ContextUsage>();
      yield* Effect.acquireRelease(
        Effect.sync(() => setStop((id) => stopThread(rpc, id))),
        () => Effect.sync(() => setStop(undefined)),
      );
      const notifications = Stream.callback<void, SourceError>((q) =>
        Effect.sync(() => {
          rpc.onNotification = (method, params) => {
            if (method === "thread/tokenUsage/updated") {
              const snapshot = codexContext(params);
              if (snapshot) contexts.set(snapshot.threadId, snapshot.usage);
              else if (typeof params?.threadId === "string") contexts.delete(params.threadId);
              Queue.offerUnsafe(q, undefined);
            } else if (RELEVANT.has(method)) Queue.offerUnsafe(q, undefined);
          };
          rpc.onClose = () => void Queue.failCauseUnsafe(q, Cause.fail(fail("failed", "codex socket closed")));
        }),
      );
      return Stream.merge(Stream.tick("60 seconds"), notifications).pipe(
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => list(m, rpc, contexts)),
      );
    }),
  );

export const launchCodex = (dir: string) => Effect.succeed({ cmd: ["codex", "-C", dir], cwd: dir, claim: { firstNewIn: dir } });
