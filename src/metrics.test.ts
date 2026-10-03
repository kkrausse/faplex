import { expect, test } from "bun:test";
import { contextCell, latestContext, subagentCell, subagentSummary, type UsageMessage } from "./metrics.ts";
import { codexContext } from "./codex.ts";

test("subagent count includes nested descendants and their activity, not other roots", () => {
  const count = subagentSummary([
    { id: "root", active: true }, { id: "child", parentId: "root", active: true },
    { id: "grandchild", parentId: "child", active: false }, { id: "other", active: false },
  ], "root", true);
  expect(count).toEqual({ total: 2, active: 1, complete: true });
  expect(subagentCell(count)).toBe("1/2");
});

test("partial counts are lower bounds and cycles cannot loop or count the root", () => {
  const count = subagentSummary([
    { id: "root", parentId: "child", active: true }, { id: "child", parentId: "root", active: false },
    { id: "child", parentId: "root", active: false },
  ], "root", false);
  expect(count.total).toBe(1);
  expect(subagentCell(count)).toBe("0/≥1");
});

test("context shows tokens, with or without a limit, and nothing when unavailable", () => {
  expect(contextCell({ usedTokens: 500, limitTokens: 1000, measuredAt: 0 })).toBe("500");
  expect(contextCell({ usedTokens: 137_285, measuredAt: 0 })).toBe("137k");
  expect(contextCell({ usedTokens: 1_234_000, measuredAt: 0 })).toBe("1.2M");
  expect(contextCell(undefined)).toBe("");
});

const assistant = (id: string): UsageMessage => ({ id, type: "assistant", time: { created: 10, completed: 20 },
  model: { id: "model", providerID: "provider" },
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 200, write: 50 } },
});

test("context uses one latest response including cache tokens, never session totals", () => {
  expect(latestContext([assistant("new"), assistant("old")])).toEqual({
    usedTokens: 375, measuredAt: 20, model: { id: "model", providerID: "provider" },
  });
});

test("context respects compaction and revert boundaries", () => {
  const compact: UsageMessage = { id: "compact", type: "compaction", status: "completed" };
  expect(latestContext([compact, assistant("old")])).toBeUndefined();
  expect(latestContext([assistant("new"), compact, assistant("old")])?.usedTokens).toBe(375);
  expect(latestContext([assistant("new"), assistant("old")], "new")?.usedTokens).toBe(375);
  expect(latestContext([assistant("new")], "missing")).toBeUndefined();
  expect(latestContext([{ ...compact, status: "running" }, assistant("old")])?.usedTokens).toBe(375);
});

test("Codex uses last-response tokens, not cumulative totals; null limits stay unavailable", () => {
  const event = { threadId: "thread", tokenUsage: { total: { totalTokens: 999999 }, last: { totalTokens: 400 }, modelContextWindow: 1000 } };
  expect(codexContext(event, 42)).toEqual({ threadId: "thread", usage: { usedTokens: 400, limitTokens: 1000, measuredAt: 42 } });
  expect(codexContext({ ...event, tokenUsage: { ...event.tokenUsage, modelContextWindow: null } })?.usage.limitTokens).toBeUndefined();
  expect(codexContext({})).toBeUndefined();
  expect(codexContext({ ...event, tokenUsage: { ...event.tokenUsage, last: { totalTokens: -1 } } })).toBeUndefined();
});
