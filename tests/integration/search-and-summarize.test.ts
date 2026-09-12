import { beforeAll, describe, expect, test } from "bun:test";
import { Array, Effect, Option, Result, String } from "effect";
import { ARTICLE_SUMMARY_LENGTHS, SummarySource, SummaryStyle } from "../../src/domain.ts";
import { Kagi } from "../../src/kagi/client.ts";
import { KagiLive } from "../../src/services.ts";
import { withTimeout } from "../../src/utils/timeout.ts";

describe.skipIf(process.env.KAGI_INTEGRATION !== "1")("live Kagi search and summarize", () => {
  let firstUrl = Option.none<string>();
  let rateLimited = false;

  beforeAll(async () => {
    const result = await Effect.runPromise(
      Effect.flatMap(Kagi, (kagi) =>
        withTimeout(kagi.search("site:bun.sh Bun runtime", 1), 30_000, "Search timeout"),
      ).pipe(Effect.result, Effect.provide(KagiLive)),
    );
    if (Result.isFailure(result)) {
      if (result.failure._tag !== "RateLimitError") throw new Error(result.failure.message);
      rateLimited = true;
      console.warn("Kagi rate limited the integration test; skipping remaining requests.");
      return;
    }
    firstUrl = Array.head(result.success.data).pipe(Option.map(({ url }) => url));
    expect(Option.isSome(firstUrl)).toBe(true);
  }, 35_000);

  const styles = [
    SummaryStyle.Keypoints(),
    SummaryStyle.Eli5(),
    SummaryStyle.Article({ length: Option.none() }),
    ...Array.map(ARTICLE_SUMMARY_LENGTHS, (length) =>
      SummaryStyle.Article({ length: Option.some(length) }),
    ),
  ];
  for (const style of styles) {
    const name = SummaryStyle.$match(style, {
      Keypoints: () => "keypoints",
      Eli5: () => "eli5",
      Article: ({ length }) => `article:${Option.getOrElse(length, () => "default")}`,
    });
    test(`summarizes as ${name}`, async () => {
      if (rateLimited) return;
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const input = yield* Effect.fromOption(firstUrl).pipe(Effect.orDie);
          const kagi = yield* Kagi;
          return yield* withTimeout(
            kagi.summarize({
              source: SummarySource.Url({ input }),
              style,
              language: Option.none(),
            }),
            60_000,
            "Summary timeout",
          );
        }).pipe(Effect.result, Effect.provide(KagiLive)),
      );
      if (Result.isFailure(result)) {
        if (result.failure._tag !== "RateLimitError") throw new Error(result.failure.message);
        rateLimited = true;
        console.warn("Kagi rate limited the integration test; skipping remaining requests.");
        return;
      }
      expect(String.isNonEmpty(String.trim(result.success))).toBe(true);
    }, 65_000);
  }
});
