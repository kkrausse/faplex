import { expect, test } from "bun:test";
import { Effect } from "effect";
import { claudeSessions, type HostRecord } from "./claude.ts";

// A live process reports `busy` for as long as anything it started is running, so these rows
// all used to show as Working.
const row = (state: string, job: object) => {
  const entry = { pid: 1, id: "j1", sessionId: "s1", kind: "background", cwd: "/w", status: "busy", state };
  const rec: HostRecord = { archive: "", claude: { missing: false, code: 0, out: JSON.stringify([entry]),
    jobs: new Map([["j1", { mtime: 0, text: JSON.stringify(job) }]]), transcripts: new Map() } };
  return Effect.runPromise(claudeSessions({ id: "m", ssh: "m" }, rec)).then((s) => s[0]!);
};
const shell = { kind: "shell", label: "bun run dev", startedAt: 1 };
const agent = { kind: "agent", label: "spike", startedAt: 1 };

test("a question asked with a shell still running needs input", async () => {
  const s = await row("blocked", { tempo: "blocked", needs: "run the phone test", fan: [{ ...agent, doneAt: 2 }, shell] });
  expect([s.status, s.detail, s.background]).toEqual(["needs", "run the phone test", { kind: "shell", count: 1, label: "bun run dev" }]);
});

test("a finished turn with a shell left running is finished", async () => {
  const s = await row("done", { tempo: "idle", detail: "validated", fan: [shell] });
  expect([s.status, s.background?.kind]).toEqual(["done", "shell"]);
});

test("a finished turn with subagents out is still working", async () => {
  const s = await row("working", { tempo: "idle", fan: [agent, shell] });
  expect([s.status, s.background]).toEqual(["working", { kind: "agent", count: 1, label: "spike" }]);
});

test("a running turn is working, with or without a tempo", async () => {
  expect((await row("working", { tempo: "active" })).status).toBe("working");
  expect((await row("working", {})).status).toBe("working");
});
