import { expect, test } from "bun:test";
import { Effect } from "effect";
import { readPages } from "./pages.ts";

test("follows pagination to provide complete counts", async () => {
  const seen: (string | undefined)[] = [];
  const result = await Effect.runPromise(readPages((cursor) => {
    seen.push(cursor);
    return Effect.succeed({ items: cursor ? [2] : [1], next: cursor ? null : "next", hasCursor: true });
  }));
  expect(seen).toEqual([undefined, "next"]);
  expect(result).toEqual({ items: [1, 2], complete: true });
});

test("bounded scans and missing cursors aren't labelled complete", async () => {
  expect((await Effect.runPromise(readPages(() => Effect.succeed({ items: [1], next: "next", hasCursor: true }), 1))).complete).toBe(false);
  expect((await Effect.runPromise(readPages(() => Effect.succeed({ items: [1], hasCursor: false })))).complete).toBe(false);
});

test("repeated cursors stop rather than looping", async () => {
  let calls = 0;
  const result = await Effect.runPromise(readPages(() => {
    calls++;
    return Effect.succeed({ items: [1], next: "same", hasCursor: true });
  }));
  expect(calls).toBe(2);
  expect(result.complete).toBe(false);
});

test("a failed historical page retains fresh rows as an incomplete scan", async () => {
  const result = await Effect.runPromise(readPages((cursor) => cursor
    ? Effect.fail(new Error("history unavailable"))
    : Effect.succeed({ items: [1], next: "next", hasCursor: true })));
  expect(result).toEqual({ items: [1], complete: false });
});

test("a failed first page remains a source error, not an empty list", async () => {
  await expect(Effect.runPromise(readPages(() => Effect.fail(new Error("offline"))))).rejects.toThrow("offline");
});
