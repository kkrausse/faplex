// `faplex tail <key>`: a session's last few messages, read from the harness without touching the
// session. Only what was said: user prompts and the agent's text replies, not tool calls, tool
// output or thinking. Claude's come from its transcript file (the end of it), OpenCode's from the
// service's message list. Codex isn't read yet.
import { Effect } from "effect";
import type { Command } from "./cli.ts";
import { fail } from "./errors.ts";
import { exec, q, sh, type Machine } from "./machines.ts";
import { parseKey } from "./session.ts";

export type Message = { role: "user" | "agent"; at: number; text: string };

// Enough for the last messages of a long session without reading a transcript of hundreds of MB.
const TAIL_BYTES = 4_000_000;
/** Longer messages are cut, with a note saying how much: `tail` is for skimming. */
const MAX_CHARS = 2000;

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((c) => (c?.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n")
      : "";

/**
 * Messages from the end of a Claude transcript (JSON lines; the first may be cut off). Replies are
 * written one content block per line, so a reply's text lines are joined by message id. User lines
 * that are tool results, harness notes (`isMeta`) or wrapped events (`<task-notification>`,
 * `<command-name>`) are not prompts.
 */
export function claudeMessages(jsonl: string): Message[] {
  const out: (Message & { id?: string })[] = [];
  for (const line of jsonl.split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain || e.isMeta) continue;
    const text = textOf(e.message?.content).trim();
    if (!text || (e.type === "user" && (text.startsWith("<") || text.startsWith("[Request interrupted")))) continue;
    const at = Date.parse(e.timestamp) || 0;
    const id = e.type === "assistant" ? e.message?.id : undefined;
    const last = out.at(-1);
    if (last && id && last.id === id) last.text += `\n${text}`;
    else out.push({ role: e.type === "user" ? "user" : "agent", at, text, id });
  }
  return out.map(({ role, at, text }) => ({ role, at, text }));
}

/** OpenCode's `/message` list, newest first: user messages carry `text`, replies `content` parts. */
export function opencodeMessages(data: readonly any[]): Message[] {
  return data
    .flatMap((m): Message[] => {
      const text = (m.type === "user" ? (m.text ?? "") : m.type === "assistant" ? textOf(m.content) : "").trim();
      return text ? [{ role: m.type === "user" ? "user" : "agent", at: m.time?.created ?? 0, text }] : [];
    })
    .reverse();
}

const claudeTail = (m: Machine, id: string) =>
  Effect.gen(function* () {
    // A background session's key carries its job id; the transcript is named by the session id.
    const agents = yield* exec(m, ["claude", "agents", "--json", "--all"]);
    let entries: { id?: string; sessionId?: string }[] = [];
    try {
      entries = JSON.parse(agents.stdout);
    } catch {}
    const sid = entries.find((e) => e.id === id || e.sessionId === id)?.sessionId ?? id;
    const out = yield* sh(m, `for f in "$HOME"/.claude/projects/*/${q(`${sid}.jsonl`)}; do [ -f "$f" ] && exec tail -c ${TAIL_BYTES} "$f"; done; echo "no transcript for ${sid}" >&2; exit 1`, { timeout: 30_000 });
    if (out.code !== 0) return yield* fail("failed", out.stderr.trim() || `tail exited ${out.code}`);
    return claudeMessages(out.stdout);
  });

const opencodeTail = (m: Machine, id: string) =>
  Effect.gen(function* () {
    const out = yield* sh(m, `opencode api get ${q(`/api/session/${id}/message?order=desc&limit=100`)}`, { timeout: 30_000 });
    if (out.code !== 0) return yield* fail("failed", out.stderr.trim() || `opencode api exited ${out.code}`);
    const data = yield* Effect.try({ try: () => JSON.parse(out.stdout).data ?? [], catch: () => fail("decode", "opencode messages: not JSON") });
    return opencodeMessages(data);
  });

const stamp = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export async function tail(machine: (id: string) => Machine, cmd: Extract<Command, { kind: "tail" }>): Promise<number> {
  const k = parseKey(cmd.key)!;
  if (k.harness === "codex") {
    process.stderr.write("faplex: tail does not read Codex sessions yet\n");
    return 1;
  }
  let messages: Message[];
  try {
    const m = machine(k.machine);
    messages = await Effect.runPromise(k.harness === "claude" ? claudeTail(m, k.id) : opencodeTail(m, k.id));
  } catch (e) {
    process.stderr.write(`faplex: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  for (const msg of messages.slice(-cmd.n)) {
    const cut = msg.text.length - MAX_CHARS;
    const text = cut > 0 ? `${msg.text.slice(0, MAX_CHARS)}\n… (${cut} more chars)` : msg.text;
    process.stdout.write(`── ${msg.role} · ${stamp(msg.at)}\n${text}\n\n`);
  }
  return 0;
}
