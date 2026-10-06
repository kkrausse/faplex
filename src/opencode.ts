// OpenCode 2.x: the background service (~/.local/state/opencode/service.json on each host) serves
// an HTTP API behind basic auth as user "opencode", reached through `forward`. Its `/api/event` SSE
// stream says when sessions, permissions or forms change; each relevant event re-reads the list.
// Pending permissions and forms mean the agent needs input.
import { Effect, Schema, Stream } from "effect";
import { decodeJson, decodeValue, fail, firstLine, type SourceError } from "./errors.ts";
import { forward, q, sh, type Machine } from "./machines.ts";
import { sessionKey, type ContextUsage, type Session, type Status } from "./session.ts";
import { latestContext, subagentSummary } from "./metrics.ts";
import { readPages } from "./pages.ts";

// Missing CLI, an old (1.x, different API) CLI, no service file, or a service file whose pid is
// gone (stale) are all quiet "not here" states.
const CHECK = `
command -v opencode >/dev/null 2>&1 || { echo "@@missing"; exit 0; }
echo "@@version $(opencode --version 2>/dev/null | head -n 1)"
f="$HOME/.local/state/opencode/service.json"
[ -f "$f" ] || { echo "@@noservice"; exit 0; }
pid=$(sed -n 's/.*"pid": *\\([0-9]*\\).*/\\1/p' "$f")
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "@@alive"; else echo "@@dead $pid"; fi
cat "$f"`;

const ServiceFile = Schema.Struct({ url: Schema.String, password: Schema.String, pid: Schema.optionalKey(Schema.Number), version: Schema.optionalKey(Schema.String) });

const service = (m: Machine) =>
  Effect.gen(function* () {
    const out = (yield* sh(m, CHECK)).stdout;
    if (out.startsWith("@@missing")) return yield* fail("missing", "not installed");
    const [version, state, ...rest] = out.split("\n");
    const v = version?.match(/(\d+)\.\d+\.\d+/);
    if (v && Number(v[1]) < 2) return yield* fail("unsupported", `unsupported (opencode ${v[0]})`);
    if (state === "@@noservice") return yield* fail("stopped", "service not running");
    if (state?.startsWith("@@dead")) return yield* fail("stopped", `service not running (stale service.json, pid ${state.slice(7) || "?"})`);
    const s = yield* decodeJson(ServiceFile, "service.json")(rest.join("\n"));
    const url = new URL(s.url);
    return { url, auth: `Basic ${btoa(`opencode:${s.password}`)}` };
  });

const Info = Schema.Struct({
  id: Schema.String,
  metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  parentID: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
  outcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
  revert: Schema.optionalKey(Schema.NullOr(Schema.Struct({ messageID: Schema.String }))),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number, archived: Schema.optionalKey(Schema.NullOr(Schema.Number)) }),
  location: Schema.optionalKey(Schema.NullOr(Schema.Struct({ directory: Schema.optionalKey(Schema.String) }))),
});
const data = <S extends Schema.Top & { readonly DecodingServices: never }>(s: S) => Schema.Struct({ data: s });
const Cursor = Schema.optionalKey(Schema.Struct({ next: Schema.NullOr(Schema.String) }));
const Sessions = decodeValue(Schema.Struct({ data: Schema.Array(Info), cursor: Cursor }), "opencode /api/session");
const Active = decodeValue(data(Schema.Record(Schema.String, Schema.Unknown)), "opencode /api/session/active");
const Perms = decodeValue(data(Schema.Array(Schema.Struct({ action: Schema.optionalKey(Schema.String) }))), "opencode permission");
const Forms = decodeValue(data(Schema.Array(Schema.Struct({ title: Schema.optionalKey(Schema.String) }))), "opencode form");
const Messages = decodeValue(data(Schema.Array(Schema.Struct({ type: Schema.String }))), "opencode messages");
const UsageMessage = Schema.Struct({
  id: Schema.String, type: Schema.String, status: Schema.optionalKey(Schema.String),
  time: Schema.optionalKey(Schema.Struct({ created: Schema.Number, completed: Schema.optionalKey(Schema.Number) })),
  model: Schema.optionalKey(Schema.Struct({ id: Schema.String, providerID: Schema.String })),
  tokens: Schema.optionalKey(Schema.Struct({ input: Schema.Number, output: Schema.Number, reasoning: Schema.Number, cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }) })),
});
const UsageMessages = decodeValue(data(Schema.Array(UsageMessage)), "opencode usage messages");
const Model = Schema.Struct({ id: Schema.String, providerID: Schema.String, limit: Schema.Struct({ context: Schema.Number }) });
const Models = decodeValue(data(Schema.Array(Model)), "opencode models");

type Api = { base: string; auth: string };

// Mini is a client choice, not a different backend. Tag only sessions launched by faplex.
export const MINI_METADATA = { "faplex.interface": "mini" };
export const opencodeHarness = (metadata?: Readonly<Record<string, unknown>> | null) =>
  metadata?.["faplex.interface"] === "mini" ? "opencode-mini" as const : "opencode" as const;
export const opencodeCommand = (id: string, mini: boolean) => ["opencode", ...(mini ? ["mini"] : []), "-s", id];

const get = (api: Api, path: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const r = await fetch(api.base + path, { headers: { authorization: api.auth }, signal });
      if (!r.ok) throw new Error(`${r.status}`);
      return (await r.json()) as unknown;
    },
    catch: (e) => fail("failed", `opencode ${path.split("?")[0]}: ${e instanceof Error ? e.message : String(e)}`),
  });

type PromptCache = Map<string, { updatedAt: number; prompted: boolean }>;
type MetricsCache = {
  contexts: Map<string, { updatedAt: number; checkedAt: number; usage?: ContextUsage }>;
  models: Map<string, { checkedAt: number; models: readonly typeof Model.Type[] }>;
};

const list = (m: Machine, home: string, api: Api, prompts: PromptCache, metrics: MetricsCache) =>
  Effect.gen(function* () {
    const [sessions, active] = yield* Effect.all([readPages((cursor) =>
      get(api, `/api/session?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).pipe(
        Effect.flatMap(Sessions), Effect.map((page) => ({ items: page.data, next: page.cursor?.next, hasCursor: !!page.cursor })),
      )), get(api, "/api/session/active").pipe(Effect.flatMap(Active))], {
      concurrency: 2,
    });
    // An idle session may contain messages without an outcome. Check for a user prompt, not
    // just any message (model/location changes also create messages). Cache until it changes.
    const roots = sessions.items.filter((s) => !s.parentID);
    const ids = new Set(roots.map((s) => s.id));
    for (const id of prompts.keys()) if (!ids.has(id)) prompts.delete(id);
    for (const id of metrics.contexts.keys()) if (!ids.has(id)) metrics.contexts.delete(id);
    yield* Effect.forEach(roots, (s) => Effect.gen(function* () {
      if (s.id in active.data || s.outcome) {
        prompts.set(s.id, { updatedAt: s.time.updated, prompted: true });
        return;
      }
      if (prompts.get(s.id)?.updatedAt === s.time.updated) return;
      // A missing/unsupported endpoint must not hide a possibly used session.
      prompts.delete(s.id);
      const messages = yield* get(api, `/api/session/${s.id}/message?type=user&limit=1`).pipe(Effect.flatMap(Messages), Effect.timeout("5 seconds"), Effect.option);
      if (messages._tag === "Some") prompts.set(s.id, { updatedAt: s.time.updated, prompted: messages.value.data.some((msg) => msg.type === "user") });
    }), { concurrency: 4, discard: true });
    // Rich context snapshots for active roots only; finished roots retain their last observed
    // snapshot. Optional lookups never break the status feed. The scan is bounded and declines
    // to report usage when a revert boundary isn't in the fetched messages.
    const contextRoots = roots.filter((s) => s.id in active.data || (metrics.contexts.has(s.id) && metrics.contexts.get(s.id)!.updatedAt !== s.time.updated));
    const now = Date.now();
    const directories = new Set(contextRoots.map((s) => s.location?.directory ?? home));
    yield* Effect.forEach([...directories], (directory) => Effect.gen(function* () {
      if (now - (metrics.models.get(directory)?.checkedAt ?? 0) < 60_000) return;
      metrics.models.delete(directory);
      const models = yield* get(api, `/api/model?location%5Bdirectory%5D=${encodeURIComponent(directory)}`).pipe(Effect.flatMap(Models), Effect.timeout("5 seconds"), Effect.option);
      metrics.models.set(directory, { checkedAt: now, models: models._tag === "Some" ? models.value.data : [] });
    }), { concurrency: 4, discard: true });
    yield* Effect.forEach(contextRoots, (s) => Effect.gen(function* () {
      const cached = metrics.contexts.get(s.id);
      if (cached && cached.updatedAt === s.time.updated && now - cached.checkedAt < 15_000) return;
      const messages = yield* get(api, `/api/session/${s.id}/message?order=desc&limit=100`).pipe(Effect.flatMap(UsageMessages), Effect.timeout("5 seconds"), Effect.option);
      const latest = messages._tag === "Some" ? latestContext(messages.value.data, s.revert?.messageID) : undefined;
      const model = latest && metrics.models.get(s.location?.directory ?? home)?.models.find((m) => m.id === latest.model.id && m.providerID === latest.model.providerID);
      metrics.contexts.set(s.id, { updatedAt: s.time.updated, checkedAt: now, usage: latest ? {
        usedTokens: latest.usedTokens, measuredAt: latest.measuredAt,
        limitTokens: model && model.limit.context > 0 ? model.limit.context : undefined,
      } : undefined });
    }), { concurrency: 4, discard: true });
    // Only running sessions can be blocked on a permission or a form.
    const pending = new Map<string, string>();
    yield* Effect.forEach(
      Object.keys(active.data),
      (id) =>
        Effect.gen(function* () {
          const [perms, forms] = yield* Effect.all(
            [get(api, `/api/session/${id}/permission`).pipe(Effect.flatMap(Perms)), get(api, `/api/session/${id}/form`).pipe(Effect.flatMap(Forms))],
            { concurrency: 2 },
          );
          if (perms.data.length) pending.set(id, `permission: ${perms.data[0]!.action ?? "request"}`);
          else if (forms.data.length) pending.set(id, forms.data[0]!.title ?? "question");
        }),
      { concurrency: 4, discard: true },
    );
    const nodes = sessions.items.map((s) => ({ id: s.id, parentId: s.parentID, active: s.id in active.data }));
    return sessions.items
      .filter((s) => !s.parentID)
      .map((s): Session => {
        const status: Status =
          pending.has(s.id) ? "needs"
          : s.id in active.data ? "working"
          : s.outcome === "succeeded" ? "done"
          : s.outcome === "failed" ? "failed"
          : s.outcome === "interrupted" ? "interrupted"
          : "idle";
        const cwd = s.location?.directory ?? home;
        const harness = opencodeHarness(s.metadata);
        return {
          machine: m.id,
          harness,
          key: sessionKey(m.id, harness, s.id),
          id: s.id,
          title: s.title || s.id,
          cwd,
          status,
          prompted: prompts.get(s.id)?.prompted,
          subagents: subagentSummary(nodes, s.id, sessions.complete),
          context: metrics.contexts.get(s.id)?.usage,
          detail: pending.get(s.id) ?? "",
          model: s.model?.id ?? "",
          updatedAt: s.time.updated,
          archived: !!s.time.archived,
          stoppable: s.id in active.data,
          open: { cmd: opencodeCommand(s.id, harness === "opencode-mini"), cwd },
        };
      });
  });

// Events that can change a row; streaming deltas, usage and tool chatter are ignored.
const RELEVANT = /^(session\.(created|deleted|updated|renamed|moved|idle|active|status|error|execution\.)|permission\.(asked|replied)|form\.)/;
const EventType = decodeJson(Schema.Struct({ type: Schema.String }), "opencode event");

/** Relevant event types; fails if the stream ends or goes silent (the server heartbeats). */
const events = (api: Api): Stream.Stream<string, SourceError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const r = yield* Effect.tryPromise({
        try: (signal) => fetch(api.base + "/api/event", { headers: { authorization: api.auth, accept: "text/event-stream" }, signal }),
        catch: (e) => fail("failed", `opencode /api/event: ${e instanceof Error ? e.message : String(e)}`),
      });
      if (!r.ok || !r.body) return yield* fail("failed", `opencode /api/event: ${r.status}`);
      const body = r.body;
      return Stream.fromReadableStream({ evaluate: () => body, onError: (e) => fail("failed", `opencode events: ${String(e)}`) });
    }),
  ).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.timeoutOrElse({ duration: "60 seconds", orElse: () => Stream.fail(fail("failed", "opencode events: no heartbeat")) }),
    Stream.concat(Stream.fail(fail("failed", "opencode events: stream ended"))),
    Stream.filter((l) => l.startsWith("data:")),
    Stream.mapEffect((l) => EventType(l.slice(5)).pipe(Effect.map((e) => e.type), Effect.orElseSucceed(() => ""))),
    Stream.filter((t) => RELEVANT.test(t)),
  );

/** Interrupts the session's running turn. OpenCode sessions never wake on their own. */
const stopSession = (api: Api, id: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const r = await fetch(`${api.base}/api/session/${id}/interrupt`, { method: "POST", headers: { authorization: api.auth }, signal });
      if (!r.ok) throw new Error(`${r.status}`);
    },
    catch: (e) => fail("failed", `opencode interrupt: ${e instanceof Error ? e.message : String(e)}`),
  });

/**
 * The machine's OpenCode sessions: the full list on start, on each relevant event, and every 60 s.
 * While connected, `setStop` holds a function that stops a session through the same forward.
 */
export const opencodeSessions = (m: Machine, home: string, setStop: (stop: ((id: string) => Effect.Effect<void, SourceError>) | undefined) => void): Stream.Stream<ReadonlyArray<Session>, SourceError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const s = yield* service(m);
      const local = yield* forward(m, { tcp: { host: s.url.hostname, port: Number(s.url.port || 80) } });
      const api = { base: `${s.url.protocol}//${local}`, auth: s.auth };
      const prompts: PromptCache = new Map();
      const metrics: MetricsCache = { contexts: new Map(), models: new Map() };
      yield* Effect.acquireRelease(
        Effect.sync(() => setStop((id) => stopSession(api, id))),
        () => Effect.sync(() => setStop(undefined)),
      );
      return Stream.merge(Stream.tick("60 seconds"), events(api)).pipe(
        // Events arriving while a list is in flight collapse into one more list.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => list(m, home, api, prompts, metrics)),
      );
    }),
  );

export const launchOpencode = (dir: string) => Effect.succeed({ cmd: ["opencode", dir], cwd: dir, claim: { firstNewIn: dir } });

const Created = decodeJson(Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }), "opencode create session");
export const launchOpencodeMini = (m: Machine, dir: string, run: typeof sh = sh) =>
  Effect.gen(function* () {
    // Create with metadata atomically, then claim by ID instead of guessing among
    // concurrent new sessions. `api` discovers/starts the same service as the CLI.
    const body = JSON.stringify({ location: { directory: dir }, metadata: MINI_METADATA });
    const out = yield* run(m, `opencode mini --help >/dev/null && opencode api post /api/session --data ${q(body)}`);
    if (out.code !== 0) return yield* fail("failed", firstLine(out.stderr) || `opencode mini launch exited ${out.code}`);
    const { data: { id } } = yield* Created(out.stdout);
    return { cmd: opencodeCommand(id, true), cwd: dir, claim: { id } };
  });
