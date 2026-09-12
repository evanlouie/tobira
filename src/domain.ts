import { Array, Boolean, Data, Effect, Option, Result, Schema, SchemaTransformation } from "effect";
import type { AppError, QueryFailure } from "./utils/errors.ts";

export const NonEmptyText = Schema.Trim.check(Schema.isMinLength(1));
export const Url = Schema.String.check(
  Schema.makeFilter((value) =>
    Boolean.match(Option.isSome(Schema.decodeOption(Schema.URLFromString)(value)), {
      onTrue: () => true,
      onFalse: () => "Expected a valid URL",
    }),
  ),
);
export const SearchLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
export const SUMMARY_TYPES = ["keypoints", "eli5", "article"] as const;
export const ARTICLE_SUMMARY_LENGTHS = [
  "headline",
  "overview",
  "digest",
  "medium",
  "long",
] as const;
export const SUPPORTED_LANGUAGES = [
  "BG",
  "CS",
  "DA",
  "DE",
  "EL",
  "EN",
  "ES",
  "ET",
  "FI",
  "FR",
  "HU",
  "ID",
  "IT",
  "JA",
  "KO",
  "LT",
  "LV",
  "NB",
  "NL",
  "PL",
  "PT",
  "RO",
  "RU",
  "SK",
  "SL",
  "SV",
  "TR",
  "UK",
  "ZH",
  "ZH-HANT",
] as const;
export const SummaryType = Schema.Literals(SUMMARY_TYPES);
export const SummaryLength = Schema.Literals(ARTICLE_SUMMARY_LENGTHS);
export const Language = Schema.Literals(SUPPORTED_LANGUAGES);

export const SearchInput = Schema.Struct({
  queries: Schema.NonEmptyArray(NonEmptyText).check(Schema.isMaxLength(10)).annotate({
    description: "One to ten concise search queries. Each query must include its own context.",
  }),
  limit: Schema.OptionFromOptionalKey(SearchLimit).annotate({
    description: "Maximum results per query (default: 10, max: 50).",
  }),
});
export type SearchInput = typeof SearchInput.Type;

/** CLI flags are an intermediate boundary value, not a domain request. */
export const SummarizerFields = Schema.Struct({
  url: Url.annotate({ description: "URL of a document to summarize." }),
  summary_type: Schema.OptionFromOptionalKey(SummaryType).annotate({
    description: "Summary style: article (default), keypoints, or eli5.",
  }),
  summary_length: Schema.OptionFromOptionalKey(SummaryLength).annotate({
    description: "Optional article length: headline, overview, digest, medium, or long.",
  }),
  target_language: Schema.OptionFromOptionalKey(Language).annotate({
    description: "Output language code, such as EN, DE, or FR. Defaults to EN.",
  }),
});

/** Article length cannot exist on a keypoints or eli5 request. */
export type SummaryStyle = Data.TaggedEnum<{
  Article: { readonly length: Option.Option<typeof SummaryLength.Type> };
  Keypoints: {};
  Eli5: {};
}>;
export const SummaryStyle = Data.taggedEnum<SummaryStyle>();

export type SummarySource = Data.TaggedEnum<{
  Url: { readonly input: string };
  Text: { readonly input: string };
}>;
export const SummarySource = Data.taggedEnum<SummarySource>();

export interface SummaryRequest {
  readonly source: SummarySource;
  readonly style: SummaryStyle;
  readonly language: Option.Option<typeof Language.Type>;
}

const UrlSource = Schema.TaggedStruct("Url", { input: Url });
const urlSummary = <S extends Schema.Constraint>(style: S) =>
  Schema.Struct({
    source: UrlSource,
    style,
    language: Schema.Option(Language),
  });
const commonSummaryFields = {
  url: SummarizerFields.fields.url,
  target_language: SummarizerFields.fields.target_language,
};
const noArticleLength = Schema.OptionFromOptionalKey(Schema.Never);

/** Each wire variant decodes directly into a valid domain request. */
export const SummarizerInput = Schema.Union([
  Schema.Struct({
    ...commonSummaryFields,
    summary_type: Schema.Literal("article").pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("article")),
    ),
    summary_length: SummarizerFields.fields.summary_length,
  }).pipe(
    Schema.decodeTo(
      urlSummary(Schema.TaggedStruct("Article", { length: Schema.Option(SummaryLength) })),
      SchemaTransformation.transform({
        decode: (input) => ({
          source: SummarySource.Url({ input: input.url }),
          style: SummaryStyle.Article({ length: input.summary_length }),
          language: input.target_language,
        }),
        encode: (request) => ({
          url: request.source.input,
          summary_type: "article" as const,
          summary_length: request.style.length,
          target_language: request.language,
        }),
      }),
    ),
  ),
  Schema.Struct({
    ...commonSummaryFields,
    summary_type: Schema.Literal("keypoints"),
    summary_length: noArticleLength,
  }).pipe(
    Schema.decodeTo(
      urlSummary(Schema.TaggedStruct("Keypoints", {})),
      SchemaTransformation.transform({
        decode: (input) => ({
          source: SummarySource.Url({ input: input.url }),
          style: SummaryStyle.Keypoints(),
          language: input.target_language,
        }),
        encode: (request) => ({
          url: request.source.input,
          summary_type: "keypoints" as const,
          summary_length: Option.none<never>(),
          target_language: request.language,
        }),
      }),
    ),
  ),
  Schema.Struct({
    ...commonSummaryFields,
    summary_type: Schema.Literal("eli5"),
    summary_length: noArticleLength,
  }).pipe(
    Schema.decodeTo(
      urlSummary(Schema.TaggedStruct("Eli5", {})),
      SchemaTransformation.transform({
        decode: (input) => ({
          source: SummarySource.Url({ input: input.url }),
          style: SummaryStyle.Eli5(),
          language: input.target_language,
        }),
        encode: (request) => ({
          url: request.source.input,
          summary_type: "eli5" as const,
          summary_length: Option.none<never>(),
          target_language: request.language,
        }),
      }),
    ),
  ),
]);
export type SummarizerInput = typeof SummarizerInput.Type;

export type Action = Data.TaggedEnum<{
  Search: { readonly input: SearchInput };
  Summarize: { readonly input: SummarizerInput };
  Mcp: {};
}>;
export const Action = Data.taggedEnum<Action>();

/** HTML attributes are decoded here; missing dates become None. */
export const SearchResult = Schema.Struct({
  title: NonEmptyText,
  url: NonEmptyText,
  snippet: Schema.String,
  publishedDate: Schema.OptionFromOptional(NonEmptyText),
});
export type SearchResult = typeof SearchResult.Type;
export interface SearchResponse {
  readonly data: ReadonlyArray<SearchResult>;
}

/** Query identity is independent of whether execution succeeded or failed. */
export interface QueryOutcome {
  readonly index: number;
  readonly query: string;
  readonly result: Result.Result<SearchResponse, AppError>;
}

export interface QuerySuccess {
  readonly index: number;
  readonly query: string;
  readonly response: SearchResponse;
}

/** A successful batch always contains at least one successful query, even if it found no results. */
export type SearchBatch = Data.TaggedEnum<{
  Complete: { readonly results: Array.NonEmptyReadonlyArray<QuerySuccess> };
  Partial: {
    readonly results: Array.NonEmptyReadonlyArray<QuerySuccess>;
    readonly failures: Array.NonEmptyReadonlyArray<QueryFailure>;
  };
}>;
export const SearchBatch = Data.taggedEnum<SearchBatch>();
