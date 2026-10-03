import { describe, expect, test } from "bun:test";
import { hasStarted, isUnprompted, type Status } from "./session.ts";

describe("draft visibility", () => {
  test("claiming an idle session does not start it", () => {
    expect(hasStarted({ status: "idle" })).toBe(false);
    expect(hasStarted({ status: "idle", prompted: false })).toBe(false);
  });

  test("only known empty drafts are hidden", () => {
    expect(isUnprompted({ status: "idle", prompted: false })).toBe(true);
    expect(isUnprompted({ status: "idle" })).toBe(false);
    expect(isUnprompted({ status: "idle", prompted: true })).toBe(false);
  });

  test("a prompt without an outcome starts an idle session", () => {
    expect(hasStarted({ status: "idle", prompted: true })).toBe(true);
  });

  test("live activity overrides stale draft metadata", () => {
    for (const status of ["working", "needs"] as Status[]) {
      expect(hasStarted({ status, prompted: false })).toBe(true);
      expect(isUnprompted({ status, prompted: false })).toBe(false);
    }
  });

  test("stopping or failing an unused draft does not make it a conversation", () => {
    for (const status of ["done", "failed", "interrupted"] as Status[]) {
      expect(hasStarted({ status, prompted: false })).toBe(false);
      expect(isUnprompted({ status, prompted: false })).toBe(true);
      expect(hasStarted({ status })).toBe(true);
    }
  });
});
