// bun scripts/build.ts [bin|npm]
//   bin  dist/faplex      standalone executable for this machine (what bin/faplex runs)
//   npm  dist/faplex.js   bundle the npm command (bin/faplex.js, a Node launcher) runs under Bun; @opentui/core stays a
//                         dependency so its native library installs per platform
import solid from "@opentui/solid/bun-plugin";

const kind = process.argv[2] ?? "bin";
const result = await Bun.build({
  entrypoints: ["src/main.tsx"],
  plugins: [solid],
  target: "bun",
  ...(kind === "npm"
    ? { outdir: "dist", naming: "faplex.js", external: ["@opentui/core"] }
    : { compile: { outfile: "dist/faplex" } }),
});
for (const log of result.logs) console.error(log);
if (!result.success) process.exit(1);
