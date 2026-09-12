import { describe, expect, test } from "bun:test";
import {
  Array,
  Boolean,
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { SearchInput } from "../../src/domain.ts";
import { Kagi } from "../../src/kagi/client.ts";
import { runSearch } from "../../src/tools/search.ts";
import { AllQueriesFailed, RateLimitError } from "../../src/utils/errors.ts";
import { formatSearchBatch } from "../../src/utils/formatting.ts";
import { authTest } from "../helpers.ts";

const searchWith = (queries: ReadonlyArray<string>, search: Kagi["Service"]["search"]) =>
  runSearch(Schema.decodeUnknownSync(SearchInput)({ queries })).pipe(
    Effect.provide(
      Layer.merge(
        authTest,
        Layer.succeed(Kagi, { search, summarize: () => Effect.die("not used") }),
      ),
    ),
  );
const allFailed = Schema.decodeUnknownSync(Schema.instanceOf(AllQueriesFailed));

describe("search batch outcomes", () => {
  test("zero-result queries are successful queries, not failures", async () => {
    const batch = await Effect.runPromise(
      searchWith(["empty", "empty"], () => Effect.succeed({ data: [] })),
    );
    expect(batch._tag).toBe("Complete");
    expect(Array.map(batch.results, ({ index, query }) => ({ index, query }))).toEqual([
      { index: 0, query: "empty" },
      { index: 1, query: "empty" },
    ]);
    expect(formatSearchBatch(batch)).not.toContain("Errors encountered");
  });

  test("a failed first query can still produce a partial batch", async () => {
    const batch = await Effect.runPromise(
      searchWith(["failed", "found"], (query) =>
        Boolean.match(query === "failed", {
          onTrue: () => Effect.fail(new RateLimitError({ message: "rate limited" })),
          onFalse: () =>
            Effect.succeed({
              data: [
                {
                  title: "Found",
                  url: "https://example.com",
                  snippet: "",
                  publishedDate: Option.none(),
                },
              ],
            }),
        }),
      ),
    );
    expect(batch._tag).toBe("Partial");
    expect(batch.results[0].index).toBe(1);
    const text = formatSearchBatch(batch);
    expect(text.indexOf('query "failed"')).toBeLessThan(text.indexOf('query "found"'));
    expect(text).toContain("1: Found");
    expect(text).toContain('Query "failed": rate limited');
  });

  test.each([1, 3])("all %i failed queries remain on the error channel", async (count) => {
    const error = allFailed(
      await Effect.runPromise(
        Effect.flip(
          searchWith(
            Array.makeBy(count, () => "duplicate"),
            () => Effect.fail(new RateLimitError({ message: "rate limited" })),
          ),
        ),
      ),
    );
    expect(
      Array.map(error.failures, ({ index, query, error }) => ({ index, query, tag: error._tag })),
    ).toEqual(
      Array.makeBy(count, (index) => ({ index, query: "duplicate", tag: "RateLimitError" })),
    );
    expect(error.message).toStartWith("All search queries failed.");
    expect(error.message).toContain('Query "duplicate": rate limited');
  });

  test("query timeouts contribute typed failures to an all-failed batch", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          Effect.flip(
            searchWith(["slow"], () =>
              Deferred.succeed(started, void 0).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("10 seconds");
        const error = allFailed(yield* Fiber.join(fiber));
        expect(error.failures[0].error._tag).toBe("TimeoutError");
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  test("defects are not converted into query failures", async () => {
    const exit = await Effect.runPromiseExit(
      searchWith(["bug"], () => Effect.die("programming error")),
    );
    Exit.match(exit, {
      onSuccess: () => {
        throw new Error("Expected a defect");
      },
      onFailure: (cause) => expect(Cause.hasDies(cause)).toBe(true),
    });
  });
});
