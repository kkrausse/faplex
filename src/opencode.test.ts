import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { launchOpencode, launchOpencodeMini, MINI_METADATA, opencodeCommand, opencodeHarness } from "./opencode.ts";
import { HARNESSES } from "./session.ts";
import { harnessShort } from "./theme.ts";
import { fail } from "./errors.ts";
import type { sh } from "./machines.ts";

describe("OpenCode interfaces", () => {
  test("Mini is a separate picker choice with distinct row labels", () => {
    expect(HARNESSES).toContain("opencode-mini");
    expect(harnessShort("opencode")).toBe("oc");
    expect(harnessShort("opencode-mini")).toBe("ocm");
  });

  test("only explicitly tagged sessions resume in Mini", () => {
    expect(opencodeHarness(MINI_METADATA)).toBe("opencode-mini");
    for (const metadata of [undefined, null, {}, { other: "mini" }, { "faplex.interface": "unknown" }]) {
      expect(opencodeHarness(metadata)).toBe("opencode");
    }
    expect(opencodeCommand("ses_example", true)).toEqual(["opencode", "mini", "-s", "ses_example"]);
    expect(opencodeCommand("ses_example", false)).toEqual(["opencode", "-s", "ses_example"]);
  });

  test("full-screen launch is unchanged", async () => {
    expect(await Effect.runPromise(launchOpencode("/project"))).toEqual({
      cmd: ["opencode", "/project"], cwd: "/project", claim: { firstNewIn: "/project" },
    });
  });
});

describe("Mini launch through the host CLI", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true });
    tmp = undefined;
  });

  const cli = (script: string) => {
    tmp = mkdtempSync("/tmp/opencode/faplex-mini-test-");
    writeFileSync(`${tmp}/opencode`, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  };

  // Explicit spawn env keeps the fixture PATH isolated from Bun's inherited environment.
  const run: typeof sh = (_m, script) => Effect.tryPromise({
    try: async () => {
      const p = Bun.spawn(["/bin/sh", "-c", script], { env: { ...process.env, PATH: `${tmp}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { stdout, stderr, code };
    },
    catch: (e) => fail("failed", String(e)),
  });

  test("creates tagged metadata at the exact directory and claims the returned ID", async () => {
    cli(`if [ "$1" = mini ]; then exit 0; fi
[ "$1" = api ] && [ "$2" = post ] && [ "$3" = /api/session ] && [ "$4" = --data ] || exit 1
printf '%s' "$5" > "$(dirname "$0")/body"
printf '%s\\n' '{"data":{"id":"ses_created"}}'`);
    const dir = "/project's folder/$(not-a-command)";
    const launch = await Effect.runPromise(launchOpencodeMini({ id: "test" }, dir, run));
    expect(JSON.parse(readFileSync(`${tmp}/body`, "utf8"))).toEqual({ location: { directory: dir }, metadata: MINI_METADATA });
    expect(launch).toEqual({ cmd: ["opencode", "mini", "-s", "ses_created"], cwd: dir, claim: { id: "ses_created" } });
  });

  test("an unavailable Mini fails before creating a session", async () => {
    cli(`if [ "$1" = mini ]; then echo 'mini unavailable' >&2; exit 1; fi
touch "$(dirname "$0")/created"`);
    const result = await Effect.runPromise(launchOpencodeMini({ id: "test" }, "/project", run).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    expect(() => readFileSync(`${tmp}/created`)).toThrow();
  });

  test("API failures and malformed responses do not launch a client", async () => {
    cli(`if [ "$1" = mini ]; then exit 0; fi
echo 'create failed' >&2; exit 1`);
    expect((await Effect.runPromise(launchOpencodeMini({ id: "test" }, "/project", run).pipe(Effect.result)))._tag).toBe("Failure");
    writeFileSync(`${tmp}/opencode`, `#!/bin/sh\nif [ "$1" = mini ]; then exit 0; fi\necho '{}'\n`, { mode: 0o700 });
    expect((await Effect.runPromise(launchOpencodeMini({ id: "test" }, "/project", run).pipe(Effect.result)))._tag).toBe("Failure");
  });
});
