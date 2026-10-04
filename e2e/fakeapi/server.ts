// Fake model API for the e2e rig. One server speaks the three wire formats the harnesses use:
//   Anthropic Messages   POST /v1/messages (+ count_tokens)        Claude Code, OpenCode (anthropic provider)
//   OpenAI Responses     POST /v1/responses                        Codex
//   OpenAI Chat          POST /v1/chat/completions                 OpenCode (openai-compatible provider)
// Replies come from scenarios.ts, chosen by the prompt text. Every request is logged; paths nothing
// here handles answer 404 and are listed at GET /_control/unhandled so gaps are visible.
//
// Control (not part of any model API):
//   GET  /_control/log                    every request so far
//   GET  /_control/unhandled              the distinct unhandled "METHOD path"s
//   GET  /_control/body?n=<log index>     the request body of one log entry
//   GET  /_control/held                   hold keys with the number of streams waiting on each
//   GET  /_control/wait-held?n=<count>    blocks until that many streams are held (seed scripts wait on this instead of sleeping)
//   POST /_control/release[?key=<key>]    finish the held streams (all, or one key)
import { pick, stepAt, type Scenario, type Step } from "./scenarios.ts";

type Entry = { n: number; at: string; method: string; path: string; wire: string; model?: string; scenario?: string; step?: number; note?: string; handled: boolean };
const log: Entry[] = [];
const bodies = new Map<number, string>();

const record = (e: Omit<Entry, "n" | "at">, body?: string): Entry => {
  const entry = { n: log.length, at: new Date().toISOString(), ...e };
  log.push(entry);
  if (body !== undefined) bodies.set(entry.n, body);
  console.log(`${entry.handled ? "ok  " : "MISS"} ${entry.method} ${entry.path} [${entry.wire}]${entry.model ? ` model=${entry.model}` : ""}${entry.scenario ? ` scenario=${entry.scenario}#${entry.step}` : ""}${entry.note ? ` ${entry.note}` : ""}`);
  return entry;
};

// Held streams: each waits on a promise resolved by /_control/release.
type Held = { key: string; release: () => void };
const held = new Set<Held>();
let heldWaiters: Array<() => void> = [];
const hold = (key: string): Promise<void> =>
  new Promise((resolve) => {
    const h: Held = { key, release: () => (held.delete(h), resolve()) };
    held.add(h);
    const waiters = heldWaiters;
    heldWaiters = [];
    for (const w of waiters) w();
  });

const json = (value: unknown, status = 200) => Response.json(value, { status });
const sse = (run: (send: (event: string | undefined, data: unknown) => void, raw: (line: string) => void) => Promise<void>) => {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        const raw = (line: string) => {
          try {
            controller.enqueue(enc.encode(line));
          } catch {}
        };
        const send = (event: string | undefined, data: unknown) => raw(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
        try {
          await run(send, raw);
        } finally {
          try {
            controller.close();
          } catch {}
        }
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } },
  );
};

/** While a stream is held, a comment line every few seconds keeps clients and proxies from timing out. */
const holdWithPings = async (key: string, ping: () => void) => {
  const timer = setInterval(ping, 5000);
  try {
    await hold(key);
  } finally {
    clearInterval(timer);
  }
};

let counter = 0;
const id = (prefix: string) => `${prefix}_${String(++counter).padStart(8, "0")}`;
const words = (text: string) => text.split(/(?<= )/);
const outTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

/** What a wire adapter extracts from a request: the last real prompt and how many tool results followed it. */
type Tool = { name: string; schema?: { properties?: Record<string, { type?: string }> } };
type Turn = { prompt: string; toolResults: number; tools: Tool[]; system: string };
const choose = (turn: Turn): { scenario: Scenario; n: number; step: Step } => {
  const scenario = pick(turn.prompt);
  return { scenario, n: turn.toolResults, step: stepAt(scenario, turn.toolResults) };
};

// Side requests the harnesses make with a small model: session titles and the like. They get a
// short deterministic answer instead of a scenario.
const titleOf = (prompt: string) => {
  const line = prompt.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ").trim().split("\n").find((l) => l.trim()) ?? "Session";
  const t = line.trim().replace(/[.?!]+$/, "");
  return t.length > 48 ? t.slice(0, 48).trim() : t;
};

// ---------------------------------------------------------------- Anthropic Messages

type ABlock = { type: string; text?: string; content?: unknown };
type AMessage = { role: string; content: string | ABlock[] };
type ABody = { model?: string; stream?: boolean; system?: string | ABlock[]; messages?: AMessage[]; tools?: { name: string; input_schema?: Tool["schema"] }[]; max_tokens?: number; output_config?: unknown };

const aText = (c: string | ABlock[] | undefined) => (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"));
const stripReminders = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

function anthropicTurn(body: ABody): Turn {
  const messages = body.messages ?? [];
  let prompt = "", toolResults = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const isResult = typeof m.content !== "string" && m.content.some((b) => b.type === "tool_result");
    if (isResult) toolResults++;
    else {
      // The text blocks of one user message: harness-injected context first, the typed prompt last.
      const blocks = typeof m.content === "string" ? [m.content] : m.content.filter((b) => b.type === "text").map((b) => b.text ?? "");
      prompt = blocks.map(stripReminders).filter(Boolean).pop() ?? "";
      break;
    }
  }
  return { prompt, toolResults, tools: (body.tools ?? []).map((t) => ({ name: t.name, schema: t.input_schema })), system: aText(body.system) };
}

const SHELL_TOOLS = ["Bash", "bash", "shell", "exec_command", "shell_command", "local_shell"];
const shellTool = (tools: Tool[]) => SHELL_TOOLS.map((n) => tools.find((t) => t.name === n)).find((t) => t);
/**
 * The shell tool's arguments, shaped by the schema the harness sent: Claude's Bash and OpenCode's
 * shell take `command` as a string, Codex's exec_command takes `cmd`, its older shell an argv array.
 */
const shellArgs = (tool: Tool, command: string): Record<string, unknown> => {
  const props = tool.schema?.properties ?? {};
  if (props.cmd) return { cmd: command };
  if (props.command?.type === "array") return { command: ["bash", "-lc", command] };
  return { command, ...(props.description ? { description: "Reset the build directory" } : {}) };
};

function anthropicReply(body: ABody, text: string, usage: { input: number }, stop: "end_turn" | "tool_use", tool?: { name: string; input: unknown }, holdKey?: { key: string; then: string }) {
  const model = body.model ?? "claude-fake";
  const msgId = id("msg");
  const usageStart = { input_tokens: usage.input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!body.stream) {
    const content: unknown[] = text ? [{ type: "text", text }] : [];
    if (tool) content.push({ type: "tool_use", id: id("toolu"), name: tool.name, input: tool.input });
    return json({ id: msgId, type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage: { ...usageStart, output_tokens: outTokens(text) } });
  }
  return sse(async (send, raw) => {
    send("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: usageStart } });
    send("ping", { type: "ping" });
    let index = 0;
    const textBlock = async (t: string) => {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const w of words(t)) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: w } });
      return () => send("content_block_stop", { type: "content_block_stop", index: index++ });
    };
    let full = text;
    if (text) {
      const stopBlock = await textBlock(text);
      if (holdKey) {
        await holdWithPings(holdKey.key, () => send("ping", { type: "ping" }));
        for (const w of words(` ${holdKey.then}`)) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: w } });
        full += ` ${holdKey.then}`;
      }
      stopBlock();
    }
    if (tool) {
      send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: id("toolu"), name: tool.name, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
      send("content_block_stop", { type: "content_block_stop", index: index++ });
    }
    send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTokens(full) } });
    send("message_stop", { type: "message_stop" });
    void raw;
  });
}

async function anthropicMessages(req: Request, path: string) {
  const text = await req.text();
  const body = JSON.parse(text) as ABody;
  const turn = anthropicTurn(body);
  // Title / topic / summary side requests: no tools, and a system prompt saying so.
  const side = sideRequest(turn, true);
  if (side !== undefined) {
    record({ method: "POST", path, wire: "anthropic", model: body.model, note: `side:${side.kind}`, handled: true }, text);
    return anthropicReply(body, side.text, { input: 120 }, "end_turn");
  }
  const { scenario, n, step } = choose(turn);
  record({ method: "POST", path, wire: "anthropic", model: body.model, scenario: scenario.name, step: n, note: `prompt=${JSON.stringify(turn.prompt.slice(0, 60))}`, handled: true }, text);
  const usage = { input: scenario.inputTokens ?? 1000 };
  if ("shell" in step) {
    const tool = shellTool(turn.tools);
    if (!tool) return anthropicReply(body, `(no shell tool offered; wanted to run: ${step.shell})`, usage, "end_turn");
    return anthropicReply(body, step.say ?? "", usage, "tool_use", { name: tool.name, input: shellArgs(tool, step.shell) });
  }
  if ("hold" in step) return anthropicReply(body, step.say, usage, "end_turn", undefined, { key: step.hold, then: step.text });
  return anthropicReply(body, step.text, usage, "end_turn");
}

/** Recognises the small-model side requests by their system prompt. `undefined` means a real turn. */
function sideRequest(turn: Turn, wantsJson: boolean): { kind: string; text: string } | undefined {
  // A real turn always offers tools; the small-model helpers never do.
  if (turn.tools.length) return undefined;
  const { system, prompt } = turn;
  const s = system.toLowerCase();
  // Claude Code's background-job classifier: after a turn it asks which state the job is in and
  // for the one-line status that `claude agents` (and faplex's status column) shows.
  if (/decide which of four states/.test(s)) {
    const ask = prompt.match(/most recent ask: "([\s\S]*?)"\n/)?.[1] ?? "";
    const tail = prompt.split(/Assistant message tail[^\n]*\n/)[1]?.trim() ?? "";
    const detail = pick(ask).detail ?? tail.slice(0, 64);
    return { kind: "job-state", text: JSON.stringify({ state: "done", detail, tempo: "idle", output: { result: tail.slice(0, 180) } }) };
  }
  if (/title/.test(s) && /(generate|concise|short|conversation|session|thread)/.test(s) && s.length < 6000) {
    const title = titleOf(prompt);
    return { kind: "title", text: wantsJson && /"title"/.test(s) ? JSON.stringify({ title }) : title };
  }
  if (/isnewtopic|new conversation topic/.test(s)) return { kind: "topic", text: JSON.stringify({ isNewTopic: false, title: null }) };
  if (/summar/.test(s) && s.length < 3000) return { kind: "summary", text: titleOf(prompt) };
  return undefined;
}

// ---------------------------------------------------------------- OpenAI Responses (Codex)

type RItem = { type?: string; role?: string; content?: string | { type: string; text?: string }[] };
type RBody = { model?: string; stream?: boolean; instructions?: string; input?: string | RItem[]; tools?: { type: string; name?: string; parameters?: Tool["schema"] }[] };

function responsesTurn(body: RBody): Turn {
  const items = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input } as RItem] : (body.input ?? []);
  let prompt = "", toolResults = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === "function_call_output" || it.type === "local_shell_call_output" || it.type === "custom_tool_call_output") toolResults++;
    else if ((it.type === "message" || it.type === undefined) && it.role === "user") {
      const t = typeof it.content === "string" ? it.content : (it.content ?? []).map((c) => c.text ?? "").join("\n");
      // Codex sends its environment/instructions context as user messages wrapped in tags.
      if (/^\s*<(environment_context|user_instructions|permissions instructions|turn_aborted|skills_instructions)/.test(t)) continue;
      prompt = t.trim();
      break;
    }
  }
  return { prompt, toolResults, tools: (body.tools ?? []).map((t) => ({ name: t.name ?? t.type, schema: t.parameters })), system: body.instructions ?? "" };
}

function responsesReply(body: RBody, text: string, inputTokens: number, tool?: { name: string; args: unknown }, holdKey?: { key: string; then: string }) {
  const respId = id("resp");
  const model = body.model ?? "gpt-fake";
  const base = { id: respId, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [] as unknown[] };
  return sse(async (send, raw) => {
    send("response.created", { type: "response.created", response: base });
    send("response.in_progress", { type: "response.in_progress", response: base });
    const output: unknown[] = [];
    let full = text;
    if (text) {
      const itemId = id("msg");
      const i = output.length;
      send("response.output_item.added", { type: "response.output_item.added", output_index: i, item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] } });
      send("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: i, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      for (const w of words(text)) send("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: i, content_index: 0, delta: w });
      if (holdKey) {
        await holdWithPings(holdKey.key, () => raw(": ping\n\n"));
        for (const w of words(` ${holdKey.then}`)) send("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: i, content_index: 0, delta: w });
        full += ` ${holdKey.then}`;
      }
      send("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: i, content_index: 0, text: full });
      const item = { type: "message", id: itemId, role: "assistant", status: "completed", content: [{ type: "output_text", text: full, annotations: [] }] };
      send("response.output_item.done", { type: "response.output_item.done", output_index: i, item });
      output.push(item);
    }
    if (tool) {
      const item = { type: "function_call", id: id("fc"), call_id: id("call"), name: tool.name, arguments: JSON.stringify(tool.args), status: "completed" };
      send("response.output_item.added", { type: "response.output_item.added", output_index: output.length, item: { ...item, arguments: "", status: "in_progress" } });
      send("response.output_item.done", { type: "response.output_item.done", output_index: output.length, item });
      output.push(item);
    }
    const out = outTokens(full);
    send("response.completed", {
      type: "response.completed",
      response: { ...base, status: "completed", output, usage: { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: out, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens + out } },
    });
  });
}

async function openaiResponses(req: Request, path: string) {
  const text = await req.text();
  const body = JSON.parse(text) as RBody;
  const turn = responsesTurn(body);
  const side = sideRequest(turn, false);
  if (side !== undefined) {
    record({ method: "POST", path, wire: "responses", model: body.model, note: `side:${side.kind}`, handled: true }, text);
    return responsesReply(body, side.text, 120);
  }
  const { scenario, n, step } = choose(turn);
  record({ method: "POST", path, wire: "responses", model: body.model, scenario: scenario.name, step: n, note: `prompt=${JSON.stringify(turn.prompt.slice(0, 60))}`, handled: true }, text);
  const input = scenario.inputTokens ?? 1000;
  if ("shell" in step) {
    const tool = shellTool(turn.tools);
    if (!tool) return responsesReply(body, `(no shell tool offered; wanted to run: ${step.shell})`, input);
    return responsesReply(body, step.say ?? "", input, { name: tool.name, args: shellArgs(tool, step.shell) });
  }
  if ("hold" in step) return responsesReply(body, step.say, input, undefined, { key: step.hold, then: step.text });
  return responsesReply(body, step.text, input);
}

// ---------------------------------------------------------------- OpenAI Chat Completions

type CMessage = { role: string; content?: string | { type: string; text?: string }[] | null };
type CBody = { model?: string; stream?: boolean; messages?: CMessage[]; tools?: { function?: { name: string; parameters?: Tool["schema"] } }[] };
const cText = (c: CMessage["content"]) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join("\n"));

async function openaiChat(req: Request, path: string) {
  const text = await req.text();
  const body = JSON.parse(text) as CBody;
  const messages = body.messages ?? [];
  let prompt = "", toolResults = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool") toolResults++;
    else if (m.role === "user") {
      prompt = stripReminders(cText(m.content));
      break;
    }
  }
  const system = messages.filter((m) => m.role === "system").map((m) => cText(m.content)).join("\n");
  const turn: Turn = { prompt, toolResults, tools: (body.tools ?? []).map((t) => ({ name: t.function?.name ?? "", schema: t.function?.parameters })), system };
  const side = sideRequest(turn, false);
  const { scenario, n, step } = choose(turn);
  record({ method: "POST", path, wire: "chat", model: body.model, ...(side ? { note: `side:${side.kind}` } : { scenario: scenario.name, step: n, note: `prompt=${JSON.stringify(prompt.slice(0, 60))}` }), handled: true }, text);
  const cid = id("chatcmpl");
  const model = body.model ?? "gpt-fake";
  const say = side ? side.text : "shell" in step ? (step.say ?? "") : "hold" in step ? step.say : step.text;
  const tool = !side && "shell" in step ? shellTool(turn.tools) : undefined;
  const toolCalls = tool && "shell" in step ? [{ index: 0, id: id("call"), type: "function", function: { name: tool.name, arguments: JSON.stringify(shellArgs(tool, step.shell)) } }] : undefined;
  const usage = { prompt_tokens: side ? 120 : (scenario.inputTokens ?? 1000), completion_tokens: outTokens(say), total_tokens: (side ? 120 : (scenario.inputTokens ?? 1000)) + outTokens(say) };
  if (!body.stream)
    return json({ id: cid, object: "chat.completion", created: 0, model, choices: [{ index: 0, message: { role: "assistant", content: say, tool_calls: toolCalls }, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage });
  return sse(async (send, raw) => {
    const chunk = (delta: unknown, finish: string | null = null, extra: object = {}) => send(undefined, { id: cid, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    chunk({ role: "assistant", content: "" });
    for (const w of words(say)) chunk({ content: w });
    if (!side && "hold" in step) {
      await holdWithPings(step.hold, () => raw(": ping\n\n"));
      for (const w of words(` ${step.text}`)) chunk({ content: w });
    }
    if (toolCalls) chunk({ tool_calls: toolCalls });
    chunk({}, toolCalls ? "tool_calls" : "stop");
    send(undefined, { id: cid, object: "chat.completion.chunk", created: 0, model, choices: [], usage });
    send(undefined, "[DONE]");
  });
}

// ---------------------------------------------------------------- Models

const ANTHROPIC_MODELS = ["claude-fake-sonnet", "claude-fake-haiku"];
const OPENAI_MODELS = ["gpt-fake"];

// ---------------------------------------------------------------- Router

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  hostname: "0.0.0.0",
  idleTimeout: 0, // held streams stay open indefinitely
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const m = req.method;

    if (path.startsWith("/_control/")) {
      if (path === "/_control/log") return json(log);
      if (path === "/_control/unhandled") return json([...new Set(log.filter((e) => !e.handled).map((e) => `${e.method} ${e.path}`))]);
      if (path === "/_control/body") return new Response(bodies.get(Number(url.searchParams.get("n"))) ?? "", { headers: { "content-type": "application/json" } });
      if (path === "/_control/held") {
        const counts: Record<string, number> = {};
        for (const h of held) counts[h.key] = (counts[h.key] ?? 0) + 1;
        return json(counts);
      }
      if (path === "/_control/wait-held") {
        const want = Number(url.searchParams.get("n") ?? 1);
        const deadline = Date.now() + Number(url.searchParams.get("timeout") ?? 60) * 1000;
        while (held.size < want && Date.now() < deadline) await Promise.race([new Promise<void>((r) => heldWaiters.push(r)), Bun.sleep(1000)]);
        return json({ held: held.size, ok: held.size >= want }, held.size >= want ? 200 : 504);
      }
      if (path === "/_control/release" && m === "POST") {
        const key = url.searchParams.get("key");
        const hit = [...held].filter((h) => !key || h.key === key);
        for (const h of hit) h.release();
        return json({ released: hit.length });
      }
      return json({ error: "unknown control endpoint" }, 404);
    }

    if (path === "/" || path === "/health") return new Response("ok");
    // Claude Code's connectivity probe.
    if (path === "/api/hello") {
      record({ method: m, path, wire: "anthropic", handled: true });
      return new Response("ok");
    }
    if (m === "POST" && path === "/v1/messages") return anthropicMessages(req, path);
    if (m === "POST" && path === "/v1/messages/count_tokens") {
      const text = await req.text();
      record({ method: m, path, wire: "anthropic", handled: true }, text);
      return json({ input_tokens: Math.ceil(text.length / 4) });
    }
    if (m === "POST" && path === "/v1/responses") return openaiResponses(req, path);
    if (m === "POST" && path === "/v1/chat/completions") return openaiChat(req, path);
    if (m === "GET" && path === "/v1/models") {
      // Both vendors list models at the same path; the anthropic-version header tells them apart.
      const anthropic = req.headers.has("anthropic-version") || req.headers.has("x-api-key");
      record({ method: m, path, wire: anthropic ? "anthropic" : "openai", handled: true });
      return anthropic
        ? json({ data: ANTHROPIC_MODELS.map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" })), has_more: false, first_id: ANTHROPIC_MODELS[0], last_id: ANTHROPIC_MODELS[1] })
        : json({ object: "list", data: OPENAI_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "fake" })) });
    }

    const body = m === "GET" || m === "HEAD" ? undefined : await req.text().catch(() => "");
    record({ method: m, path: path + url.search, wire: "?", handled: false }, body);
    return json({ type: "error", error: { type: "not_found_error", message: `fakeapi: no handler for ${m} ${path}` } }, 404);
  },
});
console.log(`fakeapi listening on :${server.port}`);
