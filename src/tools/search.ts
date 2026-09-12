import { Array, Effect, Option, Result } from "effect";
import { SearchBatch, SearchInput, type QueryOutcome } from "../domain.ts";
import { Kagi } from "../kagi/client.ts";
import { resolveToken } from "../utils/auth.ts";
import { AllQueriesFailed } from "../utils/errors.ts";
import { withTimeout } from "../utils/timeout.ts";

const withQueryContext = ({ index, query, result }: QueryOutcome) =>
  Result.mapBoth(result, {
    onSuccess: (response) => ({ index, query, response }),
    onFailure: (error) => ({ index, query, error }),
  });

/** The first outcome guarantees a non-empty batch without inventing an empty-batch state. */
const resolveBatch = ([first, ...rest]: Array.NonEmptyReadonlyArray<QueryOutcome>): Effect.Effect<
  SearchBatch,
  AllQueriesFailed
> => {
  const [failures, results] = Array.partition(rest, withQueryContext);
  return Result.match(withQueryContext(first), {
    onSuccess: (first) =>
      Array.match(failures, {
        onEmpty: () => Effect.succeed(SearchBatch.Complete({ results: [first, ...results] })),
        onNonEmpty: (failures) =>
          Effect.succeed(SearchBatch.Partial({ results: [first, ...results], failures })),
      }),
    onFailure: (first) =>
      Array.match(results, {
        onEmpty: () => Effect.fail(new AllQueriesFailed({ failures: [first, ...failures] })),
        onNonEmpty: (results) =>
          Effect.succeed(SearchBatch.Partial({ results, failures: [first, ...failures] })),
      }),
  });
};

export const runSearch = Effect.fn("runSearch")(function* (input: SearchInput) {
  yield* resolveToken;
  const kagi = yield* Kagi;
  const outcomes = yield* Effect.forEach(
    input.queries,
    (query, index) =>
      withTimeout(
        kagi.search(
          query,
          Option.getOrElse(input.limit, () => 10),
        ),
        10_000,
        "Search timeout",
      ).pipe(
        Effect.result,
        Effect.map((result) => ({ index, query, result })),
      ),
    { concurrency: 10 },
  );
  return yield* resolveBatch(outcomes);
});

export const searchToolConfig = {
  name: "kagi_search_fetch",
  title: "Kagi Search",
  description:
    "Fetch web results from Kagi for one to ten queries. Results are numbered continuously across queries. Supports an optional per-query result limit.",
  inputSchema: SearchInput,
};
