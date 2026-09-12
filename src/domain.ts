import { Data, Option, Schema } from "effect";

export const NonEmptyText = Schema.Trim.check(Schema.isMinLength(1));
export const Url = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      Option.isSome(Schema.decodeOption(Schema.URLFromString)(value)) || "Expected a valid URL",
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
  queries: Schema.Array(NonEmptyText)
    .check(Schema.isMinLength(1), Schema.isMaxLength(10))
    .annotate({
      description: "One to ten concise search queries. Each query must include its own context.",
    }),
  limit: Schema.OptionFromOptionalKey(SearchLimit).annotate({
    description: "Maximum results per query (default: 10, max: 50).",
  }),
});
export type SearchInput = typeof SearchInput.Type;

export const SummarizerInput = Schema.Struct({
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
}).check(
  Schema.makeFilter(
    (input) =>
      Option.isNone(input.summary_length) ||
      Option.getOrElse(input.summary_type, () => "article") === "article" ||
      "--length is only supported when --type is article",
  ),
);
export type SummarizerInput = typeof SummarizerInput.Type;

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
