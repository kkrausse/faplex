// A machine is local or an SSH alias. Everything remote goes through `on` (run a command there) and
// `forward` (reach a port or socket there), and every ssh rides one shared ControlMaster connection
// per host, so streams, RPCs and panes cost channels, not connections.
import { homedir, userInfo } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { Effect, Semaphore, Stream } from "effect";
import type { Machine } from "./config.ts";
import { fail, firstLine, type SourceError } from "./errors.ts";

export type { Machine };

// Non-interactive ssh shells skip .bashrc, so user-installed CLIs need these on PATH.
const DEFAULT_PATH = ["~/.local/bin", "~/.bun/bin", "~/.opencode/bin"];

// Control sockets live outside the config dir: they are transient and sun_path is ~104 bytes on
// macOS (ssh adds a ~17 char temp suffix to the 40 char %C hash while binding).
const SSH_DIR = (() => {
  const preferred = `${homedir()}/.local/state/faplex/ssh`;
  const dir = preferred.length + 58 <= 103 ? preferred : `/tmp/faplex-${userInfo().uid}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
})();

const SHARED = ["-o", "ControlMaster=auto", "-o", `ControlPath=${SSH_DIR}/%C`, "-o", "ControlPersist=10m", "-o", "ServerAliveInterval=15", "-o", "ConnectTimeout=10", "-o", "StreamLocalBindUnlink=yes"];

/** POSIX single-quote unless plainly safe. */
export const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
/** Like `q`, but a leading `~` expands on the host. */
export const qpath = (p: string) => (p === "~" ? `"$HOME"` : p.startsWith("~/") ? `"$HOME"/${q(p.slice(2))}` : q(p));

/** argv that runs `cmd` on the machine: unchanged locally, an ssh over the shared connection otherwise. */
export function on(m: Machine, cmd: readonly string[], opts: { cwd?: string; tty?: boolean } = {}): string[] {
  if (!m.ssh) return [...cmd];
  const path = [...(m.path ?? []), ...DEFAULT_PATH].map(qpath).join(":");
  const script = `PATH=${path}:"$PATH"; export PATH; ${opts.cwd ? `cd ${qpath(opts.cwd)} && ` : ""}exec ${cmd.map(q).join(" ")}`;
  return ["ssh", ...SHARED, ...(opts.tty ? ["-t"] : ["-T", "-o", "BatchMode=yes"]), m.ssh, script];
}

const ssh = (m: Machine, ...args: string[]) => ["ssh", ...SHARED, "-o", "BatchMode=yes", ...args, m.ssh!];

// Concurrent first connections would each become their own master; open it once, serially.
const masterLocks = new Map<string, Semaphore.Semaphore>();
const ensureMaster = (m: Machine): Effect.Effect<void, SourceError> =>
  Effect.gen(function* () {
    if (!m.ssh) return;
    let lock = masterLocks.get(m.id);
    if (!lock) masterLocks.set(m.id, (lock = yield* Semaphore.make(1)));
    yield* Effect.gen(function* () {
      const check = yield* spawnCollect(ssh(m, "-O", "check"));
      if (check.code === 0) return;
      const open = yield* spawnCollect(ssh(m, "-T", "-n"), "true");
      if (open.code !== 0) return yield* fail("unreachable", `${m.ssh}: ${firstLine(open.stderr) || `ssh exited ${open.code}`}`);
    }).pipe(Semaphore.withPermit(lock));
  });

type Output = { code: number; stdout: string; stderr: string };

// The backgrounded master inherits nothing we wait on: stdout/stderr are read only up to exit.
function spawnCollect(argv: string[], ...extra: string[]): Effect.Effect<Output, SourceError> {
  return Effect.tryPromise({
    try: async (signal) => {
      const p = Bun.spawn([...argv, ...extra], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    },
    catch: (e) => fail("failed", `${argv[0]}: ${e instanceof Error ? e.message : String(e)}`),
  });
}

/** Run to completion on the machine. ssh's own failures (exit 255) are `unreachable`. */
export const exec = (m: Machine, cmd: readonly string[], opts: { cwd?: string; stdin?: string; timeout?: number } = {}) =>
  Effect.gen(function* () {
    yield* ensureMaster(m);
    const out = yield* Effect.tryPromise({
      try: async (signal) => {
        const p = Bun.spawn(on(m, cmd, { cwd: opts.cwd }), {
          cwd: m.ssh ? homedir() : opts.cwd,
          stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
          stdout: "pipe",
          stderr: "pipe",
          signal,
        });
        const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        return { code, stdout, stderr } as Output;
      },
      catch: (e) => fail(m.ssh ? "unreachable" : "failed", `${cmd[0]}: ${e instanceof Error ? e.message : String(e)}`),
    }).pipe(Effect.timeoutOrElse({ duration: opts.timeout ?? 20_000, orElse: () => Effect.fail(fail("unreachable", `${m.id}: ${cmd[0]} timed out`)) }));
    if (m.ssh && out.code === 255) return yield* fail("unreachable", `${m.ssh}: ${firstLine(out.stderr) || "ssh failed"}`);
    return out;
  });

/** `sh -c script` on the machine (POSIX sh: remote hosts may have nothing else). */
export const sh = (m: Machine, script: string, opts: { stdin?: string; timeout?: number } = {}) => exec(m, ["sh", "-c", script], opts);

/**
 * stdout lines of a long-lived command on the machine; the process is killed when the stream ends.
 * With `input`, its stdin is a pipe and `input` holds a writer to it while the process runs.
 */
export const lines = (m: Machine, cmd: readonly string[], input?: (write: ((s: string) => void) | undefined) => void): Stream.Stream<string, SourceError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* ensureMaster(m);
      const p = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.spawn(on(m, cmd), { cwd: homedir(), stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" })),
        (p) =>
          Effect.sync(() => {
            if (input && p.stdin) p.stdin.end(); // EOF for whatever of the command still reads it
            p.kill();
          }),
      );
      if (input && p.stdin) {
        const stdin = p.stdin;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            input((s) => {
              stdin.write(s);
              stdin.flush();
            }),
          ),
          () => Effect.sync(() => input(undefined)),
        );
      }
      const exited = Effect.promise(async () => ({ code: await p.exited, stderr: await new Response(p.stderr).text() })).pipe(
        Effect.flatMap(({ code, stderr }) =>
          Effect.fail(fail(m.ssh && code === 255 ? "unreachable" : "failed", `${cmd[0]} exited ${code}${stderr.trim() ? `: ${firstLine(stderr)}` : ""}`)),
        ),
      );
      return Stream.fromReadableStream({ evaluate: () => p.stdout, onError: (e) => fail("failed", String(e)) }).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.concat(Stream.fromEffect(exited)),
      );
    }),
  );

const homes = new Map<string, string>();
/** `$HOME` on the machine, cached. */
export const home = (m: Machine): Effect.Effect<string, SourceError> =>
  Effect.gen(function* () {
    if (!m.ssh) return homedir();
    const cached = homes.get(m.id);
    if (cached) return cached;
    const out = yield* sh(m, 'printf %s "$HOME"');
    if (out.code !== 0 || !out.stdout.startsWith("/")) return yield* fail("failed", `${m.id}: can't read $HOME`);
    homes.set(m.id, out.stdout);
    return out.stdout;
  });

/** Expand a leading `~` with the machine's home. */
export const expand = (m: Machine, p: string) =>
  p === "~" || p.startsWith("~/") ? home(m).pipe(Effect.map((h) => h + p.slice(1))) : Effect.succeed(p);

export type Target = { tcp: { host: string; port: number } } | { unix: string };

/**
 * A local address for `target` on the machine: unchanged locally ("host:port" or a socket path);
 * remotely a forward added to the shared connection (`ssh -O forward`), cancelled with the scope.
 * Unix targets must be absolute paths on the host.
 */
export const forward = (m: Machine, target: Target) =>
  Effect.gen(function* () {
    if (!m.ssh) return "tcp" in target ? `${target.tcp.host}:${target.tcp.port}` : target.unix;
    yield* ensureMaster(m);
    const [local, remote] =
      "tcp" in target
        ? [`127.0.0.1:${yield* freePort}`, `${target.tcp.host}:${target.tcp.port}`]
        : [`${SSH_DIR}/${m.id}-${createHash("sha1").update(target.unix).digest("hex").slice(0, 8)}.sock`, target.unix];
    const spec = `${local}:${remote}`;
    if ("unix" in target) rmSync(local, { force: true });
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const r = yield* spawnCollect(ssh(m, "-O", "forward", "-L", spec));
        if (r.code !== 0) return yield* fail("unreachable", `${m.ssh}: forward ${remote}: ${firstLine(r.stderr)}`);
      }),
      () =>
        Effect.sync(() => {
          Bun.spawnSync(ssh(m, "-O", "cancel", "-L", spec), { stdout: "ignore", stderr: "ignore" });
          if ("unix" in target) rmSync(local, { force: true });
        }),
    );
    return local;
  });

const freePort = Effect.sync(() => {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
});

