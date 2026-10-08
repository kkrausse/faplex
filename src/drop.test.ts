import { describe, expect, test } from "bun:test";
import { parseDrop } from "./drop.ts";

const B = (s: string) => `\x1b[200~${s}\x1b[201~`;
const there = (p: string) => `/tmp/faplex-1000/drops/${p.split("/").pop()!.replace(/[^\w.]+/g, "-")}`;

describe("dropped file pastes", () => {
  // bun-web-terminal: `terminal.paste(paths.join(" "))` of <tmpdir>/bun-web-terminal/<session>/<8 hex>-<safe name>.
  test("bun-web-terminal upload: shell-safe paths joined by spaces", () => {
    const a = "/tmp/bun-web-terminal/3/1a2b3c4d-Screenshot-2026-10-08.png";
    const b = "/tmp/bun-web-terminal/3/9f8e7d6c.png";
    for (const frame of [B, (s: string) => s]) {
      const drop = parseDrop(frame(`${a} ${b}`))!;
      expect(drop.paths).toEqual([a, b]);
      expect(drop.render(there)).toBe(frame(`${there(a)} ${there(b)}`));
    }
  });

  test("backslash-escaped as Terminal.app and iTerm2 do, with their trailing space", () => {
    const drop = parseDrop(B("/Users/me/My\\ Docs/it\\'s\\ \\(1\\).pdf "))!;
    expect(drop.paths).toEqual(["/Users/me/My Docs/it's (1).pdf"]);
    expect(drop.render((p) => p.replace("/Users/me/My Docs", "/tmp/a b"))).toBe(B("/tmp/a\\ b/it\\'s\\ \\(1\\).pdf "));
  });

  test("single-quoted as VTE terminals do, one per line", () => {
    const drop = parseDrop(B("'/home/me/a b.png'\n'/home/me/it'\\''s.png'"))!;
    expect(drop.paths).toEqual(["/home/me/a b.png", "/home/me/it's.png"]);
    expect(drop.render(there)).toBe(B("'/tmp/faplex-1000/drops/a-b.png'\n'/tmp/faplex-1000/drops/it-s.png'"));
  });

  test("double-quoted and file:// URLs", () => {
    const drop = parseDrop('"/home/me/a \\"b\\".png" file:///home/me/caf%C3%A9%20menu.pdf\r')!;
    expect(drop.paths).toEqual(['/home/me/a "b".png', "/home/me/café menu.pdf"]);
    expect(drop.render((p) => `/r${p}`)).toBe('"/r/home/me/a \\"b\\".png" file:///r/home/me/caf%C3%A9%20menu.pdf\r');
  });

  test("a path that isn't changed keeps its exact text", () => {
    const text = B("'/etc/hosts' /home/me/x.png");
    expect(parseDrop(text)!.render((p) => (p === "/etc/hosts" ? p : "/tmp/x.png"))).toBe(B("'/etc/hosts' /tmp/x.png"));
  });

  test("anything else is not a drop", () => {
    for (const text of ["a", "\r", " ", "\x1b[D", "see /etc/hosts", "/etc/hosts and more", "relative/x.png", "~/x.png", "'/unclosed", B(""), B("hello"), "\x1b[200~/half", B("/a") + "\r"])
      expect(parseDrop(text)).toBeUndefined();
  });
});
