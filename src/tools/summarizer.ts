import { Effect } from "effect";
import { SummarizerInput } from "../domain.ts";
import { Kagi } from "../kagi/client.ts";
import { withTimeout } from "../utils/timeout.ts";

export const runSummarizer = Effect.fn("runSummarizer")(function* (input: SummarizerInput) {
  const kagi = yield* Kagi;
  return yield* withTimeout(kagi.summarize(input), 60_000, "Summarizer timeout");
});

export const summarizerToolConfig = {
  name: "kagi_summarizer",
  title: "Kagi Summarizer",
  description:
    "Summarize a URL with Kagi Summarizer. Supports webpages, video, audio, and other document types.",
  inputSchema: SummarizerInput,
};
