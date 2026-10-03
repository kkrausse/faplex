import { Effect, Schema } from "effect";

/**
 * Why a source (machine × harness) has no rows. `missing`, `unsupported` and `stopped` are quiet:
 * the harness simply isn't there, so they are listed dimly and re-checked slowly. The rest are
 * real failures, shown per source and retried with backoff.
 */
export class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  kind: Schema.Literals(["missing", "unsupported", "stopped", "unreachable", "decode", "failed"]),
  message: Schema.String,
}) {}

export const QUIET = new Set<SourceError["kind"]>(["missing", "unsupported", "stopped"]);

export const fail = (kind: SourceError["kind"], message: string) => new SourceError({ kind, message });

/** Decode untrusted JSON text with `schema`; a mismatch becomes a typed `decode` error naming `what`. */
export const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, what: string) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return (text: string): Effect.Effect<S["Type"], SourceError> =>
    decode(text).pipe(Effect.mapError((e) => fail("decode", `${what}: ${firstLine(e.message)}`)));
};

export const decodeValue = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, what: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown): Effect.Effect<S["Type"], SourceError> =>
    decode(value).pipe(Effect.mapError((e) => fail("decode", `${what}: ${firstLine(e.message)}`)));
};

export const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
