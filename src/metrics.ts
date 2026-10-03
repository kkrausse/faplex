import type { ContextUsage, Subagents } from "./session.ts";

export type AgentNode = { id: string; parentId?: string | null; active: boolean };

/** All descendants, like the session-manager picker; IDs are counted once, even in bad graphs. */
export function subagentSummary(nodes: readonly AgentNode[], rootId: string, complete: boolean): Subagents {
  const children = new Map<string, AgentNode[]>();
  for (const node of nodes) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const seen = new Set([rootId]);
  const todo = [...(children.get(rootId) ?? [])];
  let total = 0, active = 0;
  while (todo.length) {
    const node = todo.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    total++;
    if (node.active) active++;
    todo.push(...(children.get(node.id) ?? []));
  }
  return { total, active, complete };
}

/** The subagents column, `active/total`; `≥` on the total when the scan was cut short. */
export function subagentCell(s: Subagents | undefined) {
  if (!s?.total) return "";
  return `${s.active}/${s.complete ? "" : "≥"}${s.total}`;
}

/** The context column: tokens in the window, never a share of a limit that may only be assumed. */
export function contextCell(usage: ContextUsage | undefined) {
  if (!usage) return "";
  const n = usage.usedTokens;
  return n >= 999_500 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`;
}

export type UsageMessage = {
  id: string;
  type: string;
  status?: string;
  time?: { created: number; completed?: number };
  model?: { id: string; providerID: string };
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
};

/** Newest-first messages. Never reuse pre-compaction or reverted usage. */
export function latestContext(messages: readonly UsageMessage[], boundary?: string) {
  let beforeBoundary = !boundary;
  for (const message of messages) {
    if (!beforeBoundary) {
      if (message.id === boundary) beforeBoundary = true;
      continue;
    }
    if (message.type === "compaction" && message.status === "completed") return undefined;
    if (message.type !== "assistant" || !message.tokens || !message.model || !message.time) continue;
    const t = message.tokens;
    const usedTokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
    if (!Number.isFinite(usedTokens) || usedTokens <= 0) continue;
    return { usedTokens, measuredAt: message.time.completed ?? message.time.created, model: message.model };
  }
  return undefined;
}
