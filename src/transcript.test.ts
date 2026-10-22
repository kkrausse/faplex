import { expect, test } from "bun:test";
import { claudeMessages, opencodeMessages } from "./transcript.ts";

const line = (o: object) => JSON.stringify({ timestamp: "2026-10-22T13:37:00Z", ...o });

test("Claude: prompts and reply text only, a reply's blocks joined", () => {
  const jsonl = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"cut off', // the tail's first line
    line({ type: "user", message: { content: "do the thing" } }),
    line({ type: "user", isMeta: true, message: { content: "harness note" } }),
    line({ type: "assistant", message: { id: "a1", content: [{ type: "thinking", thinking: "" }] } }),
    line({ type: "assistant", message: { id: "a1", content: [{ type: "text", text: "on it" }] } }),
    line({ type: "assistant", message: { id: "a1", content: [{ type: "tool_use", name: "Bash" }] } }),
    line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
    line({ type: "assistant", message: { id: "a1", content: [{ type: "text", text: "done" }] } }),
    line({ type: "user", message: { content: "<task-notification>x</task-notification>" } }),
    line({ type: "assistant", isSidechain: true, message: { id: "s1", content: [{ type: "text", text: "subagent" }] } }),
    line({ type: "assistant", message: { id: "a2", content: [{ type: "text", text: "next" }] } }),
  ].join("\n");
  expect(claudeMessages(jsonl).map((m) => [m.role, m.text])).toEqual([
    ["user", "do the thing"],
    ["agent", "on it\ndone"],
    ["agent", "next"],
  ]);
});

test("OpenCode: newest-first list comes out oldest first, system notes dropped", () => {
  const data = [
    { type: "assistant", time: { created: 3 }, content: [{ type: "text", text: "hi" }] },
    { type: "system", time: { created: 2 }, text: "catalog" },
    { type: "user", time: { created: 1 }, text: "say hi" },
  ];
  expect(opencodeMessages(data)).toEqual([
    { role: "user", at: 1, text: "say hi" },
    { role: "agent", at: 3, text: "hi" },
  ]);
});
