import { describe, expect, test } from "bun:test";
import { Boolean, Deferred, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { SearchInput, SummarizerInput, SummarySource, SummaryStyle } from "../../src/domain.ts";
import { Kagi } from "../../src/kagi/client.ts";
import { buildSummaryRequest } from "../../src/kagi/summarize.ts";
import { runSearch } from "../../src/tools/search.ts";
import { runSummarizer } from "../../src/tools/summarizer.ts";
import { RateLimitError } from "../../src/utils/errors.ts";
import { formatSearchBatch } from "../../src/utils/formatting.ts";
import { authTest, kagiTest } from "../helpers.ts";

describe("Kagi service", () => {
  test("encodes the query and parses the HTTP response", async () => {
    const client = HttpClient.make((request, url) => {
      expect(url.pathname).toBe("/html/search");
      expect(url.searchParams.get("q")).toBe("a & b");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            '<html><body><div class="search-result"><a class="__sri_title_link" href="https://example.com">Example</a></div></body></html>',
          ),
        ),
      );
    });
    const response = await Effect.runPromise(
      Effect.flatMap(Kagi, (kagi) => kagi.search(" a & b ", 1)).pipe(
        Effect.provide(kagiTest(client)),
      ),
    );
    expect(response.data).toHaveLength(1);
  });

  test("rejects bad search limits before issuing HTTP requests", async () => {
    const client = HttpClient.make(() => Effect.die("HTTP must not execute"));
    for (const limit of [0, 51, 1.5]) {
      expect(
        await Effect.runPromise(
          Effect.flatMap(Kagi, (kagi) => kagi.search("query", limit)).pipe(
            Effect.flip,
            Effect.provide(kagiTest(client)),
          ),
        ),
      ).toMatchObject({ _tag: "ValidationError" });
    }
  });

  test("encodes URL and text summaries at the HTTP boundary", () => {
    const style = SummaryStyle.Article({ length: Option.some("digest") });
    const urlRequest = Effect.runSync(
      buildSummaryRequest({
        source: SummarySource.Url({ input: "https://example.com/?a=1&b=2" }),
        style,
        language: Option.some("EN"),
      }),
    );
    expect(urlRequest.method).toBe("GET");
    const textRequest = Effect.runSync(
      buildSummaryRequest({
        source: SummarySource.Text({ input: "Some text & more" }),
        style,
        language: Option.none(),
      }),
    );
    expect(textRequest.method).toBe("POST");
    expect(textRequest.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    if (textRequest.body._tag !== "Uint8Array") throw new Error("Expected form body");
    const form = new URLSearchParams(new TextDecoder().decode(textRequest.body.body));
    expect(form.get("text")).toBe("Some text & more");
    expect(form.get("summary_length")).toBe("digest");
    expect(form.get("target_language")).toBe("EN");
  });

  test("runs summarization through the shared service", async () => {
    const client = HttpClient.make((request, url) => {
      expect(url.pathname).toBe("/mother/summary_labs");
      expect(url.searchParams.get("url")).toBe("https://example.com");
      expect(url.searchParams.get("summary_type")).toBe("keypoints");
      expect(url.searchParams.has("summary_length")).toBe(false);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response('final:{"md":"Summary"}')),
      );
    });
    const input = Schema.decodeUnknownSync(SummarizerInput)({
      url: "https://example.com",
      summary_type: "keypoints",
    });
    expect(
      await Effect.runPromise(runSummarizer(input).pipe(Effect.provide(kagiTest(client)))),
    ).toBe("Summary");
  });
});

describe("concurrent search", () => {
  test("preserves input order and partial errors when queries finish out of order", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const secondStarted = yield* Deferred.make<void>();
        const kagi = Kagi.of({
          search: (query) =>
            Boolean.match(query === "first", {
              onTrue: () =>
                Deferred.await(secondStarted).pipe(
                  Effect.as({
                    data: [
                      {
                        title: "First",
                        url: "https://example.com",
                        snippet: "",
                        publishedDate: Option.none(),
                      },
                    ],
                  }),
                ),
              onFalse: () =>
                Deferred.succeed(secondStarted, void 0).pipe(
                  Effect.andThen(Effect.fail(new RateLimitError({ message: "rate limited" }))),
                ),
            }),
          summarize: () => Effect.die("not used"),
        });
        const batch = yield* runSearch(
          Schema.decodeUnknownSync(SearchInput)({ queries: ["first", "second"] }),
        ).pipe(Effect.provide(Layer.merge(authTest, Layer.succeed(Kagi, kagi))));
        expect(batch._tag).toBe("Partial");
        const text = formatSearchBatch(batch);
        expect(text).toContain('Results for search query "first"');
        expect(text).toContain('Results for search query "second"');
        expect(text).toContain("1: First");
        expect(text).toContain('Query "second": rate limited');
        expect(text.indexOf('query "first"')).toBeLessThan(text.indexOf('query "second"'));
      }),
    );
  });
});
