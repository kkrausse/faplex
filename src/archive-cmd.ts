// `faplex archive <key>`: what `x` does in the dashboard, for other programs (faplex-web): stop the
// session if it is running, then mark it archived. Exit 0 archived (a failed stop is printed on
// stderr but the mark is kept, as in the dashboard), 1 failed.
import type { Command } from "./cli.ts";
import { parseKey } from "./session.ts";
import { sourceKey, type DashStore } from "./store.ts";

const WAIT_MS = 30_000;

export async function archiveCommand(store: DashStore, cmd: Extract<Command, { kind: "archive" }>): Promise<number> {
  const fail = (message: string) => (process.stderr.write(`faplex: ${message}\n`), 1);
  const k = parseKey(cmd.key)!;
  const until = async (ready: () => boolean) => {
    for (const end = Date.now() + WAIT_MS; !ready(); await Bun.sleep(100)) if (Date.now() > end) return false;
    return true;
  };
  const source = () => store.state.sources[sourceKey(k.machine, k.harness)];
  if (!source()) return fail(`${k.harness} is not offered by this config`);
  if (!(await until(() => source()!.loaded))) return fail(`${k.harness} on ${k.machine} did not report in`);
  const s = store.rows(k.harness).find((r) => r.key === cmd.key);
  if (!s) return fail(`${cmd.key} is not listed`);
  try {
    const stopFailed = await store.archive(s);
    if (stopFailed) process.stderr.write(`faplex: archived, but stopping it failed: ${stopFailed}\n`);
    return 0;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
