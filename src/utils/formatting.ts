import { Array, Option } from "effect";
import type { SearchResponse } from "../domain.ts";

/** Number results continuously across queries, including partial failures. */
export function formatSearchResults(
  queries: ReadonlyArray<string>,
  responses: ReadonlyArray<SearchResponse>,
): string {
  const { chunks } = Array.reduce(
    queries,
    { next: 1, chunks: Array.empty<string>() },
    (state, query, index) => {
      const results = Array.get(responses, index).pipe(
        Option.map(({ data }) => data),
        Option.getOrElse(() => []),
      );
      const text = Array.join(
        Array.map(
          results,
          (result, index) =>
            `${state.next + index}: ${result.title}\n${result.url}\nPublished Date: ${Option.getOrElse(result.publishedDate, () => "Not Available")}\n${result.snippet}`,
        ),
        "\n\n",
      );
      return {
        next: state.next + results.length,
        chunks: Array.append(
          state.chunks,
          `-----\nResults for search query "${query}":\n-----\n${text}`,
        ),
      };
    },
  );
  return Array.join(chunks, "\n\n");
}
