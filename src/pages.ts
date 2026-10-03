import { Effect } from "effect";

/** Bound historical scans; a truncated scan must never be presented as an exact count. */
export const readPages = <T, E>(read: (cursor?: string) => Effect.Effect<{ items: readonly T[]; next?: string | null; hasCursor: boolean }, E>, maxPages = 10) =>
  Effect.gen(function* () {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      // Keep fresh first-page status when an optional historical page fails; don't erase it.
      const page = yield* read(cursor).pipe(Effect.catch((error) => i === 0 ? Effect.fail(error) : Effect.succeed(undefined)));
      if (!page) return { items, complete: false };
      items.push(...page.items);
      if (!page.hasCursor) return { items, complete: false };
      if (!page.next) return { items, complete: true };
      if (seen.has(page.next)) break;
      seen.add(page.next);
      cursor = page.next;
    }
    return { items, complete: false };
  });
