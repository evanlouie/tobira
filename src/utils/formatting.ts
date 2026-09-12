import { Array, Option, Order, Result } from "effect";
import {
  SearchBatch,
  type QueryOutcome,
  type QuerySuccess,
  type SearchResponse,
} from "../domain.ts";
import { formatQueryFailure } from "./errors.ts";

/** Number results continuously across queries, including partial failures. */
export function formatSearchResults(
  queries: ReadonlyArray<string>,
  responses: ReadonlyArray<SearchResponse>,
): string {
  const [, chunks] = Array.mapAccum(queries, 1, (next, query, index) => {
    const results = Array.get(responses, index).pipe(
      Option.map(({ data }) => data),
      Option.getOrElse(() => []),
    );
    const text = Array.join(
      Array.map(
        results,
        (result, index) =>
          `${next + index}: ${result.title}\n${result.url}\nPublished Date: ${Option.getOrElse(result.publishedDate, () => "Not Available")}\n${result.snippet}`,
      ),
      "\n\n",
    );
    return [next + results.length, `-----\nResults for search query "${query}":\n-----\n${text}`];
  });
  return Array.join(chunks, "\n\n");
}

const formatQueryOutcomes = (outcomes: ReadonlyArray<QueryOutcome>): string => {
  const ordered = Array.sort(
    outcomes,
    Order.mapInput(Order.Number, (outcome: QueryOutcome) => outcome.index),
  );
  return formatSearchResults(
    Array.map(ordered, ({ query }) => query),
    Array.map(ordered, ({ result }) => Result.getOrElse(result, () => ({ data: [] }))),
  );
};

const successfulOutcome = ({ index, query, response }: QuerySuccess): QueryOutcome => ({
  index,
  query,
  result: Result.succeed(response),
});

/** CLI and MCP render only after the batch has a typed success outcome. */
export const formatSearchBatch = SearchBatch.$match({
  Complete: ({ results }) => formatQueryOutcomes(Array.map(results, successfulOutcome)),
  Partial: ({ results, failures }) => {
    const text = formatQueryOutcomes(
      Array.appendAll(
        Array.map(results, successfulOutcome),
        Array.map(failures, ({ index, query, error }) => ({
          index,
          query,
          result: Result.fail(error),
        })),
      ),
    );
    return `${text}\n\nErrors encountered:\n${Array.join(Array.map(failures, formatQueryFailure), "\n")}`;
  },
});
