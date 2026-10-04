// Debug helper: what the Codex daemon reports for thread/list, as faplex asks it.
import { homedir } from "node:os";
import { CodexRpc } from "/home/dev/faplex/src/codex-rpc.ts";

const rpc = new CodexRpc();
await rpc.connect(`${homedir()}/.codex/app-server-control/app-server-control.sock`);
const kinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
const r = await rpc.request("thread/list", { limit: 100, sortKey: "updated_at", useStateDbOnly: true, archived: false, sourceKinds: kinds });
for (const t of r.data) console.log(JSON.stringify({ id: t.id, name: t.name, preview: t.preview, status: t.status, model: t.model, cwd: t.cwd, source: t.source }));
rpc.close();
