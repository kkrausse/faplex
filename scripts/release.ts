// bun scripts/release.ts [patch|minor|major|x.y.z]   (bun run release)
//   The one way to publish: pull main, log in to npm if needed, bump the version, npm publish
//   (npm asks for 2FA), commit, push main.
//   No git tag is created: pushing a v* tag is what triggers .github/workflows/publish.yml.
import { readFileSync } from "node:fs";

const bump = process.argv[2] ?? "patch";

const run = (...cmd: string[]) => Bun.spawnSync(cmd, { stdio: ["inherit", "inherit", "inherit"] }).exitCode === 0;
const out = (...cmd: string[]) => Bun.spawnSync(cmd).stdout.toString().trim();
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (out("git", "branch", "--show-current") !== "main") fail("release from main");
if (out("git", "status", "--porcelain", "--untracked-files=no")) fail("commit or discard changes first");
// A checkout behind origin would publish old code under the new version.
if (!run("git", "pull", "--ff-only", "origin", "main")) fail("could not fast-forward main to origin/main; sort that out first");
if (!out("npm", "whoami") && (!run("npm", "login") || !out("npm", "whoami"))) fail("npm login failed");

if (!run("bun", "test")) fail("tests failed");
if (!run("npm", "version", bump, "--no-git-tag-version")) fail("version bump failed");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
// prepublishOnly runs the type check and the npm build
if (!run("npm", "publish")) {
  run("git", "checkout", "package.json");
  fail(`publish failed; package.json restored, ${version} was not released`);
}
if (!run("git", "commit", "-am", `Release ${version}`) || !run("git", "push", "origin", "main")) {
  fail(`${version} is on npm but the release commit did not reach origin; commit and push by hand`);
}
console.log(`released faplex ${version}`);
