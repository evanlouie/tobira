import { Array, Data, Effect, Option, Schema, String } from "effect";
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

type SummaryFrame = Data.TaggedEnum<{
  Invalid: {};
  Metadata: {};
  Output: { readonly text: string };
  Rejected: { readonly message: string };
}>;
const SummaryFrame = Data.taggedEnum<SummaryFrame>();

const parseFrame = (raw: string): SummaryFrame =>
  Schema.decodeOption(StreamingMessage)(raw).pipe(
    Option.match({
      onNone: () => SummaryFrame.Invalid(),
      onSome: (message) => {
        const rejection = message.reply.pipe(
          Option.map(String.trim),
          Option.filter(String.isNonEmpty),
        );
        if (Option.contains(message.state, "error") && Option.isSome(rejection)) {
          return SummaryFrame.Rejected({ message: rejection.value });
        }
        const output = message.output_data.pipe(
          Option.flatMap(({ markdown }) => markdown),
          Option.orElse(() => message.md),
          Option.filter((text) => String.isNonEmpty(String.trim(text))),
        );
        return Option.match(output, {
          onNone: () => SummaryFrame.Metadata(),
          onSome: (text) => SummaryFrame.Output({ text }),
        });
      },
    }),
  );

interface SummaryState {
  readonly validFrames: number;
  readonly output: Option.Option<string>;
  readonly rejection: Option.Option<string>;
}
const initialState: SummaryState = {
  validFrames: 0,
  output: Option.none(),
  rejection: Option.none(),
};
const reduceFrame = (state: SummaryState, frame: SummaryFrame): SummaryState =>
  SummaryFrame.$match(frame, {
    Invalid: () => state,
    Metadata: () => ({ ...state, validFrames: state.validFrames + 1 }),
    Output: ({ text }) => ({
      ...state,
      validFrames: state.validFrames + 1,
      output: Option.some(text),
    }),
    Rejected: ({ message }) => ({
      ...state,
      validFrames: state.validFrames + 1,
      rejection: Option.orElse(state.rejection, () => Option.some(message)),
    }),
  });

/** Frames are snapshots, not deltas. Keep the latest output even when metadata follows it. */
export const parseStreamingSummary = Effect.fn("parseStreamingSummary")(function* (
  streamData: string,
) {
  if (isHtmlDocument(streamData))
    return yield* new ParseError({ message: "Unexpected HTML response from Kagi summarizer" });
  const frames = Array.getSomes(
    Array.map(String.split(streamData, "\u0000"), (raw) =>
      Schema.decodeOption(NonEmptyText)(
        String.replace(/^(?:final:|new_message\.json:)/, "")(String.trim(raw)),
      ),
    ),
  );
  if (Array.isArrayEmpty(frames))
    return yield* new ParseError({ message: "No summary data received" });
  const state = Array.reduce(frames, initialState, (state, raw) =>
    reduceFrame(state, parseFrame(raw)),
  );
  if (Option.isSome(state.rejection))
    return yield* new HttpError({ status: Option.none(), message: state.rejection.value });
  return yield* Option.match(state.output, {
    onSome: (output) => Effect.succeed({ output }),
    onNone: () =>
      Effect.fail(
        new ParseError({
          message:
            state.validFrames === 0 ? "Failed to parse summary response" : "Empty summary received",
        }),
      ),
  });
});
