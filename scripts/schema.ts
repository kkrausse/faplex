// bun scripts/schema.ts   writes schema.json (the JSON Schema of config.json) from src/config.ts.
// It is committed, since the README's `$schema` URL points at the file on GitHub.
import { Schema } from "effect";
import { ConfigSchema } from "../src/config.ts";

const doc = Schema.toJsonSchemaDocument(ConfigSchema);
const defs = Object.keys(doc.definitions).length ? { $defs: doc.definitions } : {};
await Bun.write("schema.json", JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...doc.schema, ...defs }, null, 2) + "\n");
