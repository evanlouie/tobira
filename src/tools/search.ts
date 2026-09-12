import { Array, Data, Effect, Option } from "effect";
import { SearchInput, type SearchResponse } from "../domain.ts";
import { Kagi } from "../kagi/client.ts";
import { resolveToken } from "../utils/auth.ts";
import type { AppError } from "../utils/errors.ts";
import { formatSearchResults } from "../utils/formatting.ts";
import { withTimeout } from "../utils/timeout.ts";

export type QueryOutcome = Data.TaggedEnum<{
  Succeeded: { readonly query: string; readonly response: SearchResponse };
  Failed: { readonly query: string; readonly error: AppError };
}>;
export const QueryOutcome = Data.taggedEnum<QueryOutcome>();

export const runSearch = Effect.fn("runSearch")(function* (input: SearchInput) {
  yield* resolveToken;
  const kagi = yield* Kagi;
  const outcomes = yield* Effect.forEach(
    input.queries,
    (query) =>
      withTimeout(
        kagi.search(
          query,
          Option.getOrElse(input.limit, () => 10),
        ),
        10_000,
        "Search timeout",
      ).pipe(
        Effect.match({
          onSuccess: (response) => QueryOutcome.Succeeded({ query, response }),
          onFailure: (error) => QueryOutcome.Failed({ query, error }),
        }),
      ),
    { concurrency: 10 },
  );
  const responses = Array.map(
    outcomes,
    QueryOutcome.$match({
      Succeeded: ({ response }) => response,
      Failed: () => ({ data: [] }),
    }),
  );
  const errors = Array.getSomes(
    Array.map(
      outcomes,
      QueryOutcome.$match({
        Succeeded: () => Option.none<string>(),
        Failed: ({ query, error }) => Option.some(`Query "${query}": ${error.message}`),
      }),
    ),
  );
  const text = formatSearchResults(input.queries, responses);
  return Array.match(errors, {
    onEmpty: () => text,
    onNonEmpty: (errors) => `${text}\n\nErrors encountered:\n${Array.join(errors, "\n")}`,
  });
});

export const searchToolConfig = {
  name: "kagi_search_fetch",
  title: "Kagi Search",
  description:
    "Fetch web results from Kagi for one to ten queries. Results are numbered continuously across queries. Supports an optional per-query result limit.",
  inputSchema: SearchInput,
};
