import { Effect, Match, Option } from "effect";
import { SummarizerInput, SummarySource, SummaryStyle } from "../domain.ts";
import { Kagi } from "../kagi/client.ts";
import { withTimeout } from "../utils/timeout.ts";

export const runSummarizer = Effect.fn("runSummarizer")(function* (input: SummarizerInput) {
  const kagi = yield* Kagi;
  const style = Match.value(Option.getOrElse(input.summary_type, () => "article" as const)).pipe(
    Match.when("article", () => SummaryStyle.Article({ length: input.summary_length })),
    Match.when("keypoints", () => SummaryStyle.Keypoints()),
    Match.when("eli5", () => SummaryStyle.Eli5()),
    Match.exhaustive,
  );
  return yield* withTimeout(
    kagi.summarize({
      source: SummarySource.Url({ input: input.url }),
      style,
      language: input.target_language,
    }),
    60_000,
    "Summarizer timeout",
  );
});

export const summarizerToolConfig = {
  name: "kagi_summarizer",
  title: "Kagi Summarizer",
  description:
    "Summarize a URL with Kagi Summarizer. Supports webpages, video, audio, and other document types.",
  inputSchema: SummarizerInput,
};
