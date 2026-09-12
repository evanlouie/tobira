import { Array, Boolean, Data, Effect, Option, Schema, String } from "effect";
import {
  Language,
  NonEmptyText,
  SummaryLength,
  SummarySource,
  SummaryStyle,
  type SummaryRequest,
} from "../domain.ts";
import { HttpClientRequest } from "effect/unstable/http";
import { HttpError, ParseError, ValidationError } from "../utils/errors.ts";
import { isHtmlDocument } from "./http.ts";

export { ARTICLE_SUMMARY_LENGTHS, SUMMARY_TYPES, SUPPORTED_LANGUAGES } from "../domain.ts";

const SummaryParams = Schema.Struct({
  stream: Schema.Literal("1"),
  target_language: Language,
  summary_type: Schema.Literals(["article", "keypoints", "eli5"]),
  summary_length: Schema.OptionFromOptionalKey(SummaryLength),
});

export const buildSummaryRequest = Effect.fn("buildSummaryRequest")(function* (
  request: SummaryRequest,
) {
  const style = SummaryStyle.$match(request.style, {
    Article: ({ length }) => ({ summary_type: "article" as const, summary_length: length }),
    Keypoints: () => ({
      summary_type: "keypoints" as const,
      summary_length: Option.none<typeof SummaryLength.Type>(),
    }),
    Eli5: () => ({
      summary_type: "eli5" as const,
      summary_length: Option.none<typeof SummaryLength.Type>(),
    }),
  });
  const params = yield* Schema.encodeEffect(SummaryParams)({
    ...style,
    stream: "1",
    target_language: Option.getOrElse(request.language, () => "EN"),
  }).pipe(Effect.mapError(() => new ValidationError({ message: "Invalid summary request" })));
  return SummarySource.$match(request.source, {
    Url: ({ input }) =>
      HttpClientRequest.get("https://kagi.com/mother/summary_labs").pipe(
        HttpClientRequest.setUrlParams({ ...params, url: input }),
      ),
    Text: ({ input }) =>
      HttpClientRequest.post("https://kagi.com/mother/summary_labs/").pipe(
        HttpClientRequest.bodyUrlParams({ ...params, text: input }),
      ),
  }).pipe(
    HttpClientRequest.setHeaders({
      Accept: "application/vnd.kagi.stream",
      Pragma: "no-cache",
      Referer: "https://kagi.com/summarizer",
    }),
  );
});

const StreamingMessage = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.OptionFromOptionalKey(Schema.String),
    reply: Schema.OptionFromOptionalKey(Schema.String),
    output_data: Schema.OptionFromOptionalKey(
      Schema.Struct({ markdown: Schema.OptionFromOptionalKey(Schema.String) }),
    ),
    md: Schema.OptionFromOptionalKey(Schema.String),
  }),
);

export type SummaryFrame = Data.TaggedEnum<{
  Invalid: {};
  Metadata: {};
  Output: { readonly text: string };
  Rejected: { readonly message: string };
}>;
export const SummaryFrame = Data.taggedEnum<SummaryFrame>();

const parseFrame = (raw: string): SummaryFrame =>
  Schema.decodeOption(StreamingMessage)(raw).pipe(
    Option.match({
      onNone: () => SummaryFrame.Invalid(),
      onSome: (message) => {
        const rejection = message.reply.pipe(
          Option.map(String.trim),
          Option.filter(String.isNonEmpty),
          Option.filter(() => Option.contains(message.state, "error")),
          Option.map((message) => SummaryFrame.Rejected({ message })),
        );
        const output = message.output_data.pipe(
          Option.flatMap(({ markdown }) => markdown),
          Option.orElse(() => message.md),
          Option.filter((text) => String.isNonEmpty(String.trim(text))),
          Option.map((text) => SummaryFrame.Output({ text })),
        );
        return rejection.pipe(
          Option.orElse(() => output),
          Option.getOrElse(() => SummaryFrame.Metadata()),
        );
      },
    }),
  );

/** These states cannot contain contradictory output, rejection, and frame-count fields. */
export type SummaryState = Data.TaggedEnum<{
  Empty: {};
  Unreadable: {};
  Pending: {};
  Ready: { readonly output: string };
  Rejected: { readonly message: string };
}>;
export const SummaryState = Data.taggedEnum<SummaryState>();

const stateFromFrame = SummaryFrame.$match({
  Invalid: () => SummaryState.Unreadable(),
  Metadata: () => SummaryState.Pending(),
  Output: ({ text }) => SummaryState.Ready({ output: text }),
  Rejected: ({ message }) => SummaryState.Rejected({ message }),
});

const advanceSummary = (
  state: Extract<SummaryState, { readonly _tag: "Pending" | "Ready" }>,
  frame: SummaryFrame,
): SummaryState =>
  SummaryFrame.$match(frame, {
    Invalid: () => state,
    Metadata: () => state,
    Output: ({ text }) => SummaryState.Ready({ output: text }),
    Rejected: ({ message }) => SummaryState.Rejected({ message }),
  });

/** Output frames replace snapshots. Metadata preserves progress. Rejection is terminal. */
export const reduceFrame = (state: SummaryState, frame: SummaryFrame): SummaryState =>
  SummaryState.$match(state, {
    Empty: () => stateFromFrame(frame),
    Unreadable: () => stateFromFrame(frame),
    Pending: (state) => advanceSummary(state, frame),
    Ready: (state) => advanceSummary(state, frame),
    Rejected: (state) => state,
  });

const resolveSummary = SummaryState.$match({
  Empty: () => Effect.fail(new ParseError({ message: "No summary data received" })),
  Unreadable: () => Effect.fail(new ParseError({ message: "Failed to parse summary response" })),
  Pending: () => Effect.fail(new ParseError({ message: "Empty summary received" })),
  Ready: ({ output }) => Effect.succeed({ output }),
  Rejected: ({ message }) => Effect.fail(new HttpError({ status: Option.none(), message })),
});

type SummaryDocument = Data.TaggedEnum<{
  Html: {};
  Frames: { readonly frames: ReadonlyArray<SummaryFrame> };
}>;
const SummaryDocument = Data.taggedEnum<SummaryDocument>();

const decodeDocument = (body: string): SummaryDocument =>
  Boolean.match(isHtmlDocument(body), {
    onTrue: () => SummaryDocument.Html(),
    onFalse: () =>
      SummaryDocument.Frames({
        frames: Array.map(
          Array.getSomes(
            Array.map(String.split(body, "\u0000"), (raw) =>
              Schema.decodeOption(NonEmptyText)(
                String.replace(/^(?:final:|new_message\.json:)/, "")(String.trim(raw)),
              ),
            ),
          ),
          parseFrame,
        ),
      }),
  });

export const parseStreamingSummary = Effect.fn("parseStreamingSummary")((body: string) =>
  SummaryDocument.$match(decodeDocument(body), {
    Html: () =>
      Effect.fail(new ParseError({ message: "Unexpected HTML response from Kagi summarizer" })),
    Frames: ({ frames }) => resolveSummary(Array.reduce(frames, SummaryState.Empty(), reduceFrame)),
  }),
);
