#!/usr/bin/env node
// The npm `faplex` command. faplex runs on Bun, but npx (and bunx, which honours this shebang)
// starts a package's bin under Node, so this hands over: import the bundle when already on Bun,
// else run it under the `bun` on PATH with this terminal, else say how to get Bun.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("../dist/faplex.js", import.meta.url));

if (process.versions.bun) {
  await import(bundle);
} else {
  const child = spawn("bun", [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
  // Signals sent to this process alone (a `kill`, a closing terminal) reach the dashboard too.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of signals) process.on(sig, () => child.kill(sig));
  child.on("error", (e) => {
    console.error(
      e.code === "ENOENT"
        ? "faplex needs Bun (https://bun.sh), which isn't on your PATH. Install it with:\n\n  curl -fsSL https://bun.sh/install | bash\n\nthen run faplex again."
        : `faplex: can't run bun: ${e.message}`,
    );
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (!signal) process.exit(code ?? 1);
    // Die the way the dashboard did, so the caller sees the same thing.
    for (const sig of signals) process.removeAllListeners(sig);
    process.kill(process.pid, signal);
  });
}
