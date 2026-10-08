// A file dragged onto the terminal arrives as a paste of its local path. With a remote session on
// screen that path names nothing on the agent's machine, so the file is copied there first and the
// paste forwarded with the remote path in its place. Everything else goes through as it came.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { Effect } from "effect";
import { exec, type Machine } from "./machines.ts";

const START = "\x1b[200~";
const END = "\x1b[201~";
const MAX_BYTES = 200 * 1024 * 1024;
// A bracketed paste still missing its end is held this long, and no larger than this.
const HOLD_MS = 1000;
const HOLD_BYTES = 8192;

export interface Drop {
  /** The paths named, unescaped. */
  paths: string[];
  /** The paste again, with each path that `to` changes written in the quoting it came in. */
  render(to: (path: string) => string): string;
}

// Whitespace, or one shell word: quoted runs, backslash escapes and plain characters.
const TOKEN = /(\s+)|((?:'[^']*'|"(?:\\[^]|[^"\\])*"|\\[^]|[^\s'"\\])+)/gy;
const QUOTING = /'([^']*)'|"((?:\\[^]|[^"\\])*)"|\\([^])/g;

const styles = {
  bare: (p: string) => p.replace(/[^\p{L}\p{N}_.\/+:@%,=-]/gu, "\\$&"),
  single: (p: string) => `'${p.replaceAll("'", `'\\''`)}'`,
  double: (p: string) => `"${p.replace(/["\\$`]/g, "\\$&")}"`,
  url: (p: string) => `file://${encodeURI(p)}`,
};

/**
 * A paste (bracketed or not) holding only absolute paths, as terminals type dropped files:
 * separated by spaces or newlines, each backslash-escaped, quoted, or a `file://` URL.
 */
export function parseDrop(input: string): Drop | undefined {
  const bracketed = input.startsWith(START);
  if (bracketed !== input.endsWith(END)) return;
  const body = bracketed ? input.slice(START.length, -END.length) : input;
  const parts: { text: string; path?: string; style?: keyof typeof styles }[] = [];
  let length = 0;
  for (const [text, space, word] of body.matchAll(TOKEN)) {
    length += text.length;
    if (space !== undefined) {
      parts.push({ text });
      continue;
    }
    const style = word!.startsWith("file://") ? "url" : word![0] === "'" ? "single" : word![0] === '"' ? "double" : "bare";
    let path: string;
    try {
      path =
        style === "url"
          ? decodeURIComponent(word!.slice(7).replace(/^localhost(?=\/)/, ""))
          : word!.replace(QUOTING, (_, single, double, escaped) => single ?? double?.replace(/\\(["\\$`])/g, "$1") ?? escaped);
    } catch {
      return;
    }
    if (!path.startsWith("/")) return;
    parts.push({ text, path, style });
  }
  const paths = parts.flatMap((p) => p.path ?? []);
  if (length !== body.length || !paths.length) return;
  return {
    paths,
    render: (to) => {
      const out = parts.map((p) => (p.path === undefined || to(p.path) === p.path ? p.text : styles[p.style!](to(p.path))));
      return (bracketed ? START : "") + out.join("") + (bracketed ? END : "");
    },
  };
}

const droppable = (path: string) => {
  const stat = statSync(path, { throwIfNoEntry: false });
  return !!stat?.isFile() && stat.size <= MAX_BYTES;
};

// $1: the path as pasted, left alone when it names something on this host too. $2: the name to
// store stdin under. Prints where it went. Files dropped more than a day ago are removed here.
const RECEIVE = `[ -e "$1" ] && exit 3
umask 077
t=\${TMPDIR:-/tmp}
d=\${t%/}/faplex-$(id -u)/drops
mkdir -p "$d" && [ -O "$d" ] && [ -O "\${d%/*}" ] || exit 1
find "$d" -type f -mtime +0 -exec rm -f {} +
cat > "$d/$2" && printf %s "$d/$2"`;

/** Copies the file to the machine and gives its path there, or the same path if the machine has one. */
const copy = (m: Machine, path: string) =>
  Effect.gen(function* () {
    // Shell-safe, so the harness reads the path the same in whatever quoting the paste used.
    const name = `${randomBytes(4).toString("hex")}-${basename(path).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(-80)}`;
    const out = yield* exec(m, ["sh", "-c", RECEIVE, "sh", path, name], { stdin: Bun.file(path), timeout: 300_000 });
    if (out.code === 3) return path;
    if (out.code !== 0 || !out.stdout.startsWith("/")) return yield* Effect.fail(out.stderr);
    return out.stdout;
  });

/**
 * The way to a remote client's input: `write`, except that a paste of local file paths is held
 * until the files are on the machine. Input arriving meanwhile waits behind it, in order. If a
 * copy fails the paste goes through as it was.
 */
export function remoteDrops(m: Machine, write: (data: Uint8Array) => void): (data: Uint8Array) => void {
  // A bracketed paste that looks like paths and whose end hasn't arrived.
  let partial: { data: Buffer; timer: ReturnType<typeof setTimeout> } | undefined;
  let queue: Uint8Array[] | undefined;
  const send = (chunk: Uint8Array) => {
    if (queue) return void queue.push(chunk);
    let data = Buffer.from(chunk);
    if (partial) {
      clearTimeout(partial.timer);
      data = Buffer.concat([partial.data, data]);
      partial = undefined;
    }
    const text = data.toString();
    if (/^\x1b\[200~\s*(?:['"]?\/|file:\/\/|$)/.test(text) && !text.includes(END) && data.length < HOLD_BYTES) {
      partial = { data, timer: setTimeout(() => ((partial = undefined), write(data)), HOLD_MS) };
      return;
    }
    const drop = parseDrop(text);
    if (!drop?.paths.every(droppable)) return write(data);
    const held = (queue = []);
    Effect.runPromise(Effect.forEach([...new Set(drop.paths)], (p) => copy(m, p).pipe(Effect.map((to) => [p, to] as const))))
      .then(
        (copied) => {
          const to = new Map(copied);
          write(Buffer.from(drop.render((p) => to.get(p) ?? p)));
        },
        () => write(data),
      )
      .finally(() => {
        queue = undefined;
        for (const d of held) send(d);
      });
  };
  return send;
}
