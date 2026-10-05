# Agent notes

- Merge by default. When a requested change is done and checked (`bun run check`, `bun test`),
  merge its branch into `main` in the local checkout without asking; `faplex` runs from that
  checkout. Say so in the report instead of leaving a branch to merge. Hold back only when the
  request says not to merge, or the change is exceptionally risky; then say why in the report.
- This holds for a session working in its own worktree too: a harness's general "don't merge"
  rule doesn't apply here. If the worktree can't touch the main checkout, leave the worktree
  (keeping it) and merge from the main checkout.
